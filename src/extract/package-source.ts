import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join as joinNative, resolve as resolveNative, sep } from "node:path";
import { exports as resolveExportsField, legacy as legacyEntry } from "resolve.exports";

/**
 * Where a surface lives inside a package, and how to read it.
 *
 * Everything the module extractor needs from a package sits behind one small
 * interface, so the extractor never touches the filesystem itself. Tests hand it
 * an in-memory package and stay offline; the real path hands it a directory.
 *
 * Reading is the only operation. Nothing here executes package code, which is
 * the whole point: extraction happens over bytes a consumer would receive, not
 * over a running copy of an untrusted package.
 */

export type PackageJson = {
  name?: string;
  version?: string;
  exports?: unknown;
  main?: string;
  module?: string;
  [key: string]: unknown;
};

export interface PackageSource {
  /** Parsed package.json, or null when the package has none. */
  packageJson(): PackageJson | null;
  /** Read one file by package-relative POSIX path. null when it is not there. */
  readFile(path: string): string | null;
  /** The package's own view of a bare dependency, or null when it is unavailable. */
  dependency(name: string): PackageSource | null;
}

/**
 * Which condition set the consumer would hit.
 *
 * It matters: a package can ship different files to `import` and `require`, and
 * those files can carry different contracts.
 */
export type EntryCondition = "import" | "require";

export type EntryPointQuery = {
  /** Subpath exactly as a consumer writes it: "." or "./ai-sdk". */
  subpath?: string;
  condition?: EntryCondition;
  /** Extra export conditions, e.g. "workerd". */
  conditions?: readonly string[];
};

export type EntryPoint =
  | { found: true; path: string; candidates: string[] }
  | {
      found: false;
      /**
       * `not_exported` — the package does not offer this subpath at all. That is
       * the surface being absent, and it is a legitimate answer, not a failure.
       * `file_missing` — the package points at a file it did not ship.
       */
      reason: "no_package_json" | "not_exported" | "file_missing";
      candidates: string[];
    };

// --- POSIX path helpers -----------------------------------------------------
// Package-internal paths are POSIX in package.json regardless of host OS, so
// they are normalized here rather than through node:path.

function normalizePosix(path: string): string {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

function dirnamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** "./dist/pack.js" and "dist/pack.js" are the same file; store one form. */
function toPackageRelative(path: string): string {
  return normalizePosix(path.replace(/^\.\//, ""));
}

/**
 * Extensionless and directory imports, the way a resolver would try them.
 *
 * Built packages usually name the file exactly, but TypeScript output and
 * hand-written `exports` maps both produce specifiers that need probing.
 */
function candidatePaths(base: string): string[] {
  const path = toPackageRelative(base);
  if (path === "") return [];
  const withExtension = /\.(js|mjs|cjs|json|jsx)$/.test(path);
  if (withExtension) return [path];
  return [
    path,
    `${path}.js`,
    `${path}.mjs`,
    `${path}.cjs`,
    `${path}.json`,
    `${path}/index.js`,
    `${path}/index.mjs`,
    `${path}/index.cjs`,
  ];
}

function firstExisting(source: PackageSource, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (source.readFile(candidate) !== null) return candidate;
  }
  return null;
}

// --- Entry point resolution -------------------------------------------------

/**
 * What the package says this subpath resolves to, before checking the disk.
 *
 * Kept separate from the read so the "package does not export this" answer is
 * pure and testable without a filesystem.
 */
/**
 * The prefix that marks an executable entry rather than an importable one.
 *
 * `bin:mcp-server-filesystem` is a real door and is named as one, because a
 * consumer reaches it by spawning a command rather than importing a module.
 */
export const BIN_PREFIX = "bin:";

/** `bin` normalized to a map, whichever of the two shapes the package used. */
function binEntries(pkg: PackageJson): Map<string, string> {
  const bin = pkg["bin"];
  if (typeof bin === "string") {
    const name = typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : "default";
    return new Map([[name, bin]]);
  }
  if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) {
    return new Map(
      Object.entries(bin as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  return new Map();
}

export function declaredEntryPoints(pkg: PackageJson, query: EntryPointQuery = {}): string[] | null {
  const subpath = query.subpath ?? ".";

  // An executable door. Whole categories of package — MCP servers above all —
  // ship no `exports` and no `main`; the command *is* the interface, and the
  // tool descriptions behind it are the contract.
  if (subpath.startsWith(BIN_PREFIX)) {
    const target = binEntries(pkg).get(subpath.slice(BIN_PREFIX.length));
    return target === undefined ? null : [target];
  }
  const options = {
    require: query.condition === "require",
    ...(query.conditions ? { conditions: query.conditions } : {}),
  };

  if (pkg.exports !== undefined && pkg.exports !== null) {
    try {
      const resolved = resolveExportsField(pkg, subpath, options);
      // `exports` is a closed door: an unlisted subpath is genuinely unreachable.
      if (!resolved || resolved.length === 0) return null;
      return [...resolved];
    } catch {
      return null;
    }
  }

  // No `exports` field means the old rules apply: "." follows main/module, and
  // any other subpath is a direct file path into the package.
  if (subpath === ".") {
    const fields = query.condition === "require" ? ["main", "module"] : ["module", "main"];
    const legacy = legacyEntry(pkg, { browser: false, fields });
    return [typeof legacy === "string" && legacy.length > 0 ? legacy : "./index.js"];
  }
  return [subpath];
}

/**
 * Every subpath a consumer could import, as the package declares them.
 *
 * This is how the tool finds the doors without being told: a package that
 * exposes `.`, `./ai-sdk` and `./mastra` has three surfaces, and each one is a
 * separate contract that has to be read and compared on its own.
 *
 * Wildcard patterns are skipped. `./auth/*` cannot be enumerated without
 * guessing what is behind it, and guessing a door is how you end up comparing
 * two things that were never the same surface.
 */
export function exportedSubpaths(pkg: PackageJson): string[] {
  const bins = [...binEntries(pkg).keys()].map((name) => `${BIN_PREFIX}${name}`).sort();
  const exports = pkg.exports;

  const importable = (): string[] => {
    if (exports === undefined || exports === null) return ["."];
    if (typeof exports === "string" || Array.isArray(exports)) return ["."];

    const keys = Object.keys(exports as Record<string, unknown>);
    // An `exports` object with no "./" keys is a bare condition map for ".".
    const subpaths = keys.filter((key) => key === "." || key.startsWith("./"));
    if (subpaths.length === 0) return ["."];
    return subpaths.filter((key) => !key.includes("*")).sort();
  };

  // A package with a `bin` and no `exports`/`main` is not a library at all, and
  // offering it a phantom "." door would only ever produce `file_missing`.
  const hasImportable =
    (exports !== undefined && exports !== null) ||
    typeof pkg.main === "string" ||
    typeof pkg.module === "string";

  return hasImportable || bins.length === 0 ? [...importable(), ...bins] : bins;
}

/** Resolve a subpath to a file that actually exists in the package. */
export function resolveEntryPoint(source: PackageSource, query: EntryPointQuery = {}): EntryPoint {
  const pkg = source.packageJson();
  if (pkg === null) return { found: false, reason: "no_package_json", candidates: [] };

  const declared = declaredEntryPoints(pkg, query);
  if (declared === null) return { found: false, reason: "not_exported", candidates: [] };

  const candidates = declared.flatMap(candidatePaths);
  const path = firstExisting(source, candidates);
  return path === null ? { found: false, reason: "file_missing", candidates } : { found: true, path, candidates };
}

// --- Specifier resolution, for following constants across files -------------

export type ResolvedModule = { source: PackageSource; path: string };

/**
 * Resolve one import specifier to a readable module.
 *
 * Relative specifiers stay inside the package. Bare ones cross into a
 * dependency, which is worth following: a pack routinely names its tools with
 * constants exported by a sibling package, and refusing to look means reporting
 * a tool whose name we claim not to know.
 */
export function resolveSpecifier(
  specifier: string,
  fromPath: string,
  source: PackageSource,
  query: EntryPointQuery = {},
): ResolvedModule | null {
  if (specifier.startsWith("node:") || specifier.startsWith("data:")) return null;

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = dirnamePosix(toPackageRelative(fromPath));
    const joined = normalizePosix(base === "" ? specifier : `${base}/${specifier}`);
    const path = firstExisting(source, candidatePaths(joined));
    return path === null ? null : { source, path };
  }

  // Bare: "@scope/name/sub" or "name/sub".
  const parts = specifier.split("/");
  const scoped = specifier.startsWith("@");
  const nameLength = scoped ? 2 : 1;
  if (scoped && parts.length < 2) return null;
  const name = parts.slice(0, nameLength).join("/");
  const rest = parts.slice(nameLength).join("/");

  const dependency = source.dependency(name);
  if (dependency === null) return null;

  const entry = resolveEntryPoint(dependency, {
    ...query,
    subpath: rest === "" ? "." : `./${rest}`,
  });
  return entry.found ? { source: dependency, path: entry.path } : null;
}

// --- Filesystem implementation ----------------------------------------------

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A package on disk.
 *
 * Reads are pinned inside the package directory. A published package is
 * untrusted input, and its import specifiers are attacker-controlled strings —
 * `../../../` in one of them must not turn extraction into a file read on the
 * host.
 */
export function fsPackageSource(packageDir: string): PackageSource {
  const root = resolveNative(packageDir);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const dependencies = new Map<string, PackageSource | null>();
  let manifest: PackageJson | null | undefined;

  const contained = (relative: string): string | null => {
    if (isAbsolute(relative)) return null;
    const full = resolveNative(joinNative(root, relative));
    return full === root || full.startsWith(rootPrefix) ? full : null;
  };

  return {
    packageJson() {
      if (manifest !== undefined) return manifest;
      const full = contained("package.json");
      if (full === null || !isFile(full)) {
        manifest = null;
        return manifest;
      }
      try {
        manifest = JSON.parse(readFileSync(full, "utf8")) as PackageJson;
      } catch {
        manifest = null;
      }
      return manifest;
    },

    readFile(path) {
      const full = contained(path);
      if (full === null || !isFile(full)) return null;
      try {
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },

    dependency(name) {
      const cached = dependencies.get(name);
      if (cached !== undefined) return cached;

      // Node's own lookup: nearest node_modules first, then upward.
      let directory = root;
      let found: PackageSource | null = null;
      for (;;) {
        const candidate = joinNative(directory, "node_modules", ...name.split("/"));
        if (isFile(joinNative(candidate, "package.json"))) {
          found = fsPackageSource(candidate);
          break;
        }
        const parent = resolveNative(directory, "..");
        if (parent === directory) break;
        directory = parent;
      }

      dependencies.set(name, found);
      return found;
    },
  };
}

/** An in-memory package. Used by tests, and by anything reading a tarball into memory. */
export function memoryPackageSource(
  files: Record<string, string>,
  dependencies: Record<string, PackageSource> = {},
): PackageSource {
  const normalized = new Map(Object.entries(files).map(([k, v]) => [toPackageRelative(k), v]));
  return {
    packageJson() {
      const raw = normalized.get("package.json");
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as PackageJson;
      } catch {
        return null;
      }
    },
    readFile(path) {
      return normalized.get(toPackageRelative(path)) ?? null;
    },
    dependency(name) {
      return dependencies[name] ?? null;
    },
  };
}
