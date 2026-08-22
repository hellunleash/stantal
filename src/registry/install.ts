import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export const DEFAULT_CACHE_ROOT = ".stantal/npm";

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
