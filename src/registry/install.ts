import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fsPackageSource, type PackageJson, type PackageSource } from "../extract/package-source.js";
import { assertRegistrySpec, RegistryError, type Registry } from "./npm.js";

/**
 * Unpacking a published version so its contract can be read.
 *
 * Unpacked, never installed. No `node_modules` is built, no lifecycle script
 * runs, nothing is imported. The directory this produces is a pile of files to
 * read, which is all contract extraction has ever needed.
 *
 * Direct dependencies come down too, because a pack routinely names its tools
 * with constants exported by a sibling package. Without them the extractor can
 * see a descriptor and not what it is called.
 *
 * The cache is permanent by design. A published version is immutable, so
 * `name@version` never has to be fetched twice — which is what makes reading
 * the full release history of ten SDKs a one-time cost.
 */

export type InstallOptions = {
  registry: Registry;
  /** Where unpacked versions live. */
  root?: string;
  /** Dependency hops to fetch. Shared constants almost always sit one hop away. */
  depth?: number;
};

export type Installed = {
  source: PackageSource;
  directory: string;
  /** Dependencies that could not be fetched. Constants from them read as unresolved. */
  missing: string[];
};

/**
 * Where unpacked tarballs live, and why it is not in the project.
 *
 * This directory holds **other people's code**, unpacked — it is `node_modules`
 * shaped: large, disposable, and reconstructible from the registry. It used to
 * default to `.stantal/npm` inside the repository, and a real install showed
 * what that costs. In a project with 33 dependencies it reached 60MB, nothing
 * ignored it, so the first `git add -A` staged an unpacked copy of every
 * dependency — and because those tarballs carry the packages' own test files, a
 * bare `vitest run` collected 153 test files instead of 7 and ended red on
 * somebody else's suite.
 *
 * **The other `.stantal/` directories stay in the project on purpose.** The
 * judge, behaviour and intent caches are recordings, and `--replay` exists so
 * they can be committed and replayed by anyone. Those are project artifacts.
 * This one never was.
 *
 * `--cache <dir>` still points it anywhere, including back inside the repo.
 */
export const DEFAULT_CACHE_ROOT = defaultCacheRoot();

function defaultCacheRoot(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"];
    if (local !== undefined && local.length > 0) return join(local, "stantal", "npm");
    return join(home, "AppData", "Local", "stantal", "npm");
  }
  // XDG where it is set, and its own documented default where it is not.
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "stantal", "npm");
  return join(home, ".cache", "stantal", "npm");
}

/**
 * A cache that ignores itself, wherever it is put.
 *
 * Belt and braces for the default above: `--cache` can still point this inside
 * a repository, an existing install already has one there, and the failure mode
 * is somebody committing 60MB of somebody else's source. `*` covers the
 * `.gitignore` too, so the directory leaves no trace in `git status` at all.
 *
 * Written once when the root is created, never rewritten — a file the user has
 * edited is theirs.
 */
function ensureIgnored(root: string): void {
  const marker = join(root, ".gitignore");
  if (existsSync(marker)) return;
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, "# Unpacked third-party tarballs. Disposable; never commit.\n*\n", "utf8");
  } catch {
    // A cache we could not mark is still a usable cache. This is housekeeping,
    // and failing a read of a package over it would be the wrong trade.
  }
}

/** `@scope/name` -> `@scope+name`, so one version is one directory on any OS. */
function directoryName(name: string): string {
  return name.replace(/\//g, "+");
}

/** Written only after a successful unpack, so a half-extracted directory is never trusted. */
const MARKER = ".stantal-extracted";

function readManifest(directory: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * A package whose dependencies were fetched ahead of time.
 *
 * Extraction is synchronous, and fetching is not. Resolving the dependency graph
 * up front is what lets those two live together: by the time the extractor asks
 * for a sibling package, it is already on disk.
 */
function withDependencies(
  directory: string,
  dependencies: Map<string, PackageSource>,
): PackageSource {
  const base = fsPackageSource(directory);
  return {
    packageJson: () => base.packageJson(),
    readFile: (path) => base.readFile(path),
    dependency: (name) => dependencies.get(name) ?? base.dependency(name),
  };
}

export async function installPackage(
  name: string,
  version: string,
  options: InstallOptions,
): Promise<Installed> {
  const root = options.root ?? DEFAULT_CACHE_ROOT;
  ensureIgnored(root);
  const depth = options.depth ?? 1;
  const inFlight = new Map<string, Promise<PackageSource>>();
  const missing: string[] = [];

  async function unpack(pkg: string, exact: string): Promise<string> {
    assertRegistrySpec(pkg, exact);
    const directory = join(root, directoryName(pkg), exact);
    if (existsSync(join(directory, MARKER))) return directory;

    mkdirSync(directory, { recursive: true });
    await options.registry.extract(pkg, exact, directory);
    writeFileSync(join(directory, MARKER), new Date().toISOString(), "utf8");
    return directory;
  }

  async function install(pkg: string, exact: string, remaining: number): Promise<PackageSource> {
    const key = `${pkg}@${exact}`;
    const running = inFlight.get(key);
    // A dependency cycle is normal in a monorepo. Sharing the in-flight promise
    // makes it terminate instead of recursing forever.
    if (running !== undefined) return running;

    const promise = (async () => {
      const directory = await unpack(pkg, exact);
      const dependencies = new Map<string, PackageSource>();
      if (remaining <= 0) return withDependencies(directory, dependencies);

      const manifest = readManifest(directory);
      const declared = (manifest?.["dependencies"] ?? {}) as Record<string, string>;

      await Promise.all(
        Object.entries(declared).map(async ([dependency, range]) => {
          try {
            const resolved = await options.registry.manifest(dependency, range);
            dependencies.set(dependency, await install(dependency, resolved.version, remaining - 1));
          } catch (error) {
            // A private or unpublished dependency is common and is not fatal.
            // The cost is narrow and visible: constants it exports read as
            // unresolved, and the extractor notes each one.
            if (!(error instanceof RegistryError)) throw error;
            missing.push(`${dependency}@${range}`);
          }
        }),
      );

      return withDependencies(directory, dependencies);
    })();

    inFlight.set(key, promise);
    return promise;
  }

  const source = await install(name, version, depth);
  return { source, directory: join(root, directoryName(name), version), missing: [...new Set(missing)] };
}
