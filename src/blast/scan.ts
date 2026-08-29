import semver from "semver";
import type { PackageJson } from "../extract/package-source.js";
import type { RepoSource } from "./repo.js";
import { compareReaches, type BlastNote, type BlastResult, type Filtered, type Reach } from "./taxonomy.js";
import { GENERATED_MARKER } from "../emit/vitest.js";

/**
 * One thing a finding is about, reduced to what a scan can look for.
 *
 * Deliberately not the finding itself. Layer 3 should not know the prose
 * taxonomy or the structural one — what reaches a consumer is the same question
 * whether the finding came from a deleted sentence or a removed parameter, and
 * a scanner that switched on rule names would need editing every time a rule
 * was added.
 */
export type BlastTarget = {
  /** The finding's own target, reported back verbatim so it can be matched up. */
  label: string;
  /** The door the finding sits on: ".", "./ai-sdk", "bin:name", or a filename. */
  surface: string;
  tool: string;
  /** Set when the finding is about one parameter. */
  param?: string;
};

export type BlastOptions = {
  repo: RepoSource;
  /** The package the findings are about. */
  package: string;
  /**
   * Versions the findings are present in.
   *
   * Compared against the *declared range*, not the installed version. A caret
   * range that resolves clean today still admits the defect on the next
   * install, and a consumer deciding whether they are exposed needs to know
   * that before it happens rather than after.
   */
  affectedVersions: readonly string[];
  targets: readonly BlastTarget[];
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function declaredRange(pkg: PackageJson, name: string): { field: string; range: string } | null {
  for (const field of DEPENDENCY_FIELDS) {
    const block = pkg[field];
    if (typeof block !== "object" || block === null) continue;
    const range = (block as Record<string, unknown>)[name];
    if (typeof range === "string") return { field, range };
  }
  return null;
}

/**
 * Which subpath of the package this specifier imports.
 *
 * `@scope/name` and `name` both map to `.`; anything after the package name
 * becomes `./rest`. Returns null when the specifier is a different package —
 * `@vendoai/vendo-extra` must not match `@vendoai/vendo`, which a plain
 * `startsWith` would happily do.
 */
export function subpathOf(specifier: string, pkg: string): string | null {
  if (specifier === pkg) return ".";
  if (!specifier.startsWith(`${pkg}/`)) return null;
  return `./${specifier.slice(pkg.length + 1)}`;
}

/** `from "x"`, `require("x")`, `import("x")`. Textual, and honest about it. */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Every line where a bare word appears, as a whole word. */
function wordLines(text: string, word: string): number[] {
  const out: number[] = [];
  const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  text.split("\n").forEach((line, i) => {
    if (pattern.test(line)) out.push(i + 1);
  });
  return out;
}

/**
 * Which of a consumer's code a set of findings actually reaches.
 *
 * Reads only: nothing is written, nothing is executed, and nothing leaves the
 * machine. The one layer that touches private code is also the one that needs
 * no network at all.
 */
export function blastRadius(options: BlastOptions): BlastResult {
  const { repo, package: pkg, affectedVersions, targets } = options;

  const reaches: Reach[] = [];
  const filtered: Filtered[] = [];
  const notes: BlastNote[] = [];

  // --- is the package even here, and does the range admit the defect? -------

  const manifest = repo.packageJson();
  if (manifest === null) {
    // No manifest is a gap, never "not a dependency". A workspace member, a
    // Deno project, or a repo we were pointed at one directory too deep all
    // land here, and all of them may still use the package.
    notes.push({ where: "package.json", detail: "no readable manifest, so dependency reach is unknown" });
  } else {
    const declared = declaredRange(manifest, pkg);
    if (declared === null) {
      // Evidenced: there is a manifest and it does not name the package.
      for (const target of targets) {
        filtered.push({ target: target.label, kind: "not_a_dependency", reason: `${pkg} is not a declared dependency` });
      }
      return {
        reaches,
        filtered,
        notes,
        scanned: { files: 0, bytes: 0 },
      };
    }

    const usable = affectedVersions.filter((v) => semver.valid(v) !== null);
    const admits =
      semver.validRange(declared.range) === null || usable.length === 0
        ? null
        : usable.some((v) => semver.satisfies(v, declared.range));

    if (admits === null) {
      // `workspace:*`, `file:../x`, a git url. Real and common, and not
      // something to guess at: an unparseable range is reported as unknown
      // rather than resolved to either answer.
      notes.push({
        where: "package.json",
        detail: `"${declared.range}" is not a comparable semver range, so version reach is unknown`,
      });
    } else if (admits) {
      reaches.push({
        kind: "dependency",
        target: pkg,
        evidence: `package.json (${declared.field})`,
        detail: `"${declared.range}" admits ${usable.filter((v) => semver.satisfies(v, declared.range)).length} affected version(s)`,
      });
    } else {
      for (const target of targets) {
        filtered.push({
          target: target.label,
          kind: "range_excludes",
          reason: `"${declared.range}" admits no affected version`,
        });
      }
      return { reaches, filtered, notes, scanned: { files: 0, bytes: 0 } };
    }
  }

  // --- what the repo actually imports, and what it names --------------------

  const importedSubpaths = new Map<string, string>(); // subpath -> evidence
  const toolFiles = new Map<string, Array<{ path: string; line: number }>>();
  let files = 0;
  let bytes = 0;

  const toolNames = [...new Set(targets.map((t) => t.tool))];

  for (const path of repo.files()) {
    const text = repo.read(path);
    if (text === null) {
      notes.push({ where: path, detail: "listed but could not be read" });
      continue;
    }

    // Our own emitted suite is not one of the consumer's call sites. It names
    // every tool it pins, by construction, so scanning it turns one generated
    // file into dozens of reaches and buries the handful that are real — the
    // same failure as scanning a lockfile, found the same way, by running it.
    //
    // Not a note: a note means we could not read something, and would stop
    // `canClaimUnaffected` from ever being true. We read this one and know
    // exactly what it is.
    if (text.lastIndexOf(GENERATED_MARKER, 200) !== -1) continue;

    files += 1;
    bytes += text.length;

    SPECIFIER.lastIndex = 0;
    for (let m = SPECIFIER.exec(text); m !== null; m = SPECIFIER.exec(text)) {
      const specifier = m[1];
      if (specifier === undefined) continue;
      const subpath = subpathOf(specifier, pkg);
      if (subpath === null) continue;
      if (!importedSubpaths.has(subpath)) {
        importedSubpaths.set(subpath, `${path}:${lineOf(text, m.index)}`);
      }
    }

    for (const tool of toolNames) {
      for (const line of wordLines(text, tool)) {
        const rows = toolFiles.get(tool) ?? [];
        rows.push({ path, line });
        toolFiles.set(tool, rows);
      }
    }
  }

  // --- per finding ----------------------------------------------------------

  for (const target of targets) {
    // A door the repo never opens cannot reach it, however true the finding is.
    // Only applied to subpath-shaped surfaces: a `bin:` surface is a command, and
    // a manifest filename is not something a repo imports at all, so neither can
    // be ruled out by looking at import specifiers.
    const isSubpath = target.surface === "." || target.surface.startsWith("./");
    if (isSubpath && importedSubpaths.size > 0 && !importedSubpaths.has(target.surface)) {
      filtered.push({
        target: target.label,
        kind: "subpath_not_imported",
        reason: `the repo does not import ${pkg}${target.surface === "." ? "" : target.surface.slice(1)}`,
      });
      continue;
    }

    const importedAt = isSubpath ? importedSubpaths.get(target.surface) : undefined;
    if (importedAt !== undefined) {
      reaches.push({
        kind: "surface_import",
        target: target.surface,
        evidence: importedAt,
        detail: `imports the door ${target.label} is on`,
      });
    }

    const hits = toolFiles.get(target.tool) ?? [];
    for (const hit of hits) {
      reaches.push({
        kind: "tool_reference",
        target: target.tool,
        evidence: `${hit.path}:${hit.line}`,
        detail: `names \`${target.tool}\``,
      });
    }

    // Parameters are ordinary words. A match only counts inside a file that is
    // demonstrably about the tool, which is the difference between a useful
    // pointer and every file in the repo.
    if (target.param !== undefined) {
      const paths = [...new Set(hits.map((h) => h.path))];
      for (const path of paths) {
        const text = repo.read(path);
        if (text === null) continue;
        for (const line of wordLines(text, target.param)) {
          reaches.push({
            kind: "param_reference",
            target: `${target.tool}.${target.param}`,
            evidence: `${path}:${line}`,
            detail: `names \`${target.param}\` in a file that uses \`${target.tool}\``,
          });
        }
      }
    }
  }

  reaches.sort(compareReaches);
  return { reaches, filtered, notes, scanned: { files, bytes } };
}
