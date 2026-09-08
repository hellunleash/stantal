import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { PackageJson } from "../extract/package-source.js";

/**
 * The consumer's own repository, behind an interface.
 *
 * An interface for the same reason `Registry` is one: the tests that matter
 * here are about which text counts as a reach, and those must run offline with
 * no fixture directory on disk. It also keeps the one layer that touches
 * private code to a surface small enough to audit — three methods, all reads.
 */
export interface RepoSource {
  /** Repo-relative POSIX paths of every file worth scanning. */
  files(): string[];
  /** One file by repo-relative POSIX path. null when it cannot be read. */
  read(path: string): string | null;
  /** The repo's own manifest, or null when it has none. */
  packageJson(): PackageJson | null;
}

/**
 * Extensions worth reading.
 *
 * A deliberate allowlist rather than a denylist of `node_modules` and friends.
 * A denylist silently starts scanning whatever a repo adds next — build output,
 * vendored copies, a lockfile — and a match inside vendored code would be
 * reported as the consumer's own call site.
 */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".svelte",
  ".vue",
];

/**
 * Extensions that hold prose rather than code.
 *
 * Listed and read, but never treated as a call site. A system prompt is as
 * often a Markdown file as a string literal, and `stale_quote` is the one
 * finding that has to see it: a prompt quoting a sentence the contract no
 * longer contains is stale wherever it lives.
 *
 * Kept apart from the source list because the other reaches must not widen with
 * it. A README naming a tool is documentation, not a line that stops working,
 * and reporting it as a `tool_reference` would put an unactionable entry at the
 * top of the one list a consumer reads.
 */
const PROSE_EXTENSIONS = [".md", ".mdx", ".txt", ".mdc", ".prompt"];

/** True for a file listed for its prose, never for its code. */
export function isProseFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return PROSE_EXTENSIONS.some((ext) => base.endsWith(ext));
}

/** Never descended into. Their contents are not the consumer's own code. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "vendor",
]);

/**
 * Generated files that are not the consumer's own code.
 *
 * A lockfile names every transitive package and pins its version, so a scan
 * that reads one reports a "call site" at `package-lock.json:2279`. That is
 * worse than a missed reach: it is a checkable claim that does not survive
 * being checked, in the one layer whose output a consumer uses to decide
 * whether to act. Matched by basename, since they can sit in any workspace.
 */
const GENERATED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "composer.lock",
]);

/** Big enough to hold any hand-written source file, small enough to bound a scan. */
const MAX_FILE_BYTES = 2_000_000;

export function isScannable(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (GENERATED_FILES.has(base)) return false;
  return SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) || isProseFile(base);
}

/**
 * How a walk decides what to list.
 *
 * Layer 3 wants the consumer's source and stays out of dot directories, which
 * hold tooling rather than code. Contract discovery wants the opposite: a
 * host-generated tool list usually lives in exactly such a directory, and
 * `.agent/tools.json` is the case this was written against.
 */
type WalkRules = {
  keep: (basename: string) => boolean;
  /** Descend into `.name` directories. `.git` and the skip list are excluded either way. */
  dotDirectories: boolean;
};

function sourceOver(root: string, rules: WalkRules): RepoSource {
  let listed: string[] | null = null;

  const walk = (dir: string, out: string[]): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory. Left out of the listing rather than throwing:
      // the caller records it as a gap, and a partial scan that says so is
      // worth more than no scan at all.
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory() && !rules.dotDirectories) continue;
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full, out);
      } else if (entry.isFile() && rules.keep(entry.name)) {
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
        } catch {
          continue;
        }
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };

  return {
    files() {
      if (listed === null) {
        const out: string[] = [];
        walk(root, out);
        listed = out.sort();
      }
      return listed;
    },
    read(path) {
      try {
        return readFileSync(join(root, path.split("/").join(sep)), "utf8");
      } catch {
        return null;
      }
    },
    packageJson() {
      const text = this.read("package.json");
      if (text === null) return null;
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
      } catch {
        return null;
      }
    },
  };
}

/** The consumer's own source, for Layer 3. Dot directories are tooling, not code. */
export function fsRepoSource(root: string): RepoSource {
  return sourceOver(root, { keep: isScannable, dotDirectories: false });
}

/**
 * Every JSON document in the repo, for contract discovery.
 *
 * Descends into dot directories, which Layer 3 skips. A host writes its
 * generated tool list where its own tooling lives, so the directory Layer 3 is
 * right to ignore is the first place to look here.
 */
export function fsJsonSource(root: string): RepoSource {
  return sourceOver(root, {
    keep: (name) => name.endsWith(".json") && !GENERATED_FILES.has(name),
    dotDirectories: true,
  });
}

/** In-memory repo, for tests and for a caller that already has the text. */
export function memoryRepoSource(files: Record<string, string>): RepoSource {
  return {
    files: () => Object.keys(files).filter(isScannable).sort(),
    read: (path) => files[path] ?? null,
    packageJson() {
      const text = files["package.json"];
      if (text === undefined) return null;
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
      } catch {
        return null;
      }
    },
  };
}
