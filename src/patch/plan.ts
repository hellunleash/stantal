import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Contract, Tool } from "../contract/types.js";
import type { ProseFinding } from "../prose/taxonomy.js";
import type { Report } from "../report.js";
import { encodings, type PatchEdit, type PatchPlan, type PatchRefusal } from "./taxonomy.js";

/**
 * Planning a prose restoration.
 *
 * The shape of the problem: the contract reader gives an *evaluated* string —
 * what a model would receive. The file on disk holds a *literal*. Restoring one
 * means finding the literal, and the only honest way to do that without
 * re-parsing every file is an exact search that must hit exactly once.
 *
 * Exactly once is the whole safety story. Zero hits means we cannot locate it
 * and must say so. More than one means the choice of which to edit is a guess,
 * and a guess that edits somebody's dependency is worse than doing nothing.
 */

/** Rules whose repair is a restoration of deleted prose. */
const RESTORABLE: ReadonlySet<string> = new Set(["guidance_removed", "mode_switch_changed", "example_removed"]);

/** Files worth searching: shipped JavaScript, in every flavour it is published as. */
const CODE = /\.(?:js|mjs|cjs|ts|mts|cts|json)$/;

/**
 * Directories never worth walking.
 *
 * A nested `node_modules` belongs to a different package and editing it would
 * patch a dependency of the dependency without saying so. Source maps and type
 * declarations carry copies of the same strings, which would turn a single
 * clean match into an ambiguous one and refuse an edit that was actually fine.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "__tests__", "test", "tests"]);
const SKIP_FILES = /\.(?:d\.ts|js\.map|min\.js)$/;

/** Every candidate file in a package directory, as package-relative POSIX paths. */
export function codeFiles(packageDir: string, limit = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(entry)) walk(full);
        continue;
      }
      if (!CODE.test(entry) || SKIP_FILES.test(entry)) continue;
      out.push(relative(packageDir, full).split(sep).join("/"));
    }
  };
  walk(packageDir);
  return out.sort();
}

type Located =
  | { found: true; file: string; find: string; encoding: "raw" | "escaped" }
  | { found: false; reason: "not_found" | "ambiguous"; detail: string };

/**
 * Where does this exact text live, and does it live in exactly one place?
 *
 * Both encodings are tried across every file. Two matches anywhere — the same
 * file twice, two files, or one file under each encoding — is ambiguous, and
 * ambiguous is refused.
 */
export function locate(text: string, packageDir: string, files: readonly string[]): Located {
  const hits: Array<{ file: string; find: string; encoding: "raw" | "escaped" }> = [];

  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(join(packageDir, file), "utf8");
    } catch {
      continue;
    }
    for (const { encoding, text: needle } of encodings(text)) {
      let from = 0;
      for (;;) {
        const at = contents.indexOf(needle, from);
        if (at < 0) break;
        hits.push({ file, find: needle, encoding });
        if (hits.length > 1) {
          return {
            found: false,
            reason: "ambiguous",
            detail: `appears in more than one place (${hits.map((h) => h.file).join(", ")})`,
          };
        }
        from = at + needle.length;
      }
    }
  }

  const only = hits[0];
  if (only === undefined) {
    return { found: false, reason: "not_found", detail: `no file in the package contains the text as shipped` };
  }
  return { found: true, ...only };
}

function toolsByName(contract: Contract): Map<string, Tool> {
  return new Map(contract.tools.map((t) => [t.name, t]));
}

export type PlanOptions = {
  report: Report;
  /** The unpacked directory of the version to be patched — the newer side. */
  packageDir: string;
  /** The version on disk, for the record. */
  version?: string;
};

/**
 * Which tools deserve a restoration, and where the text lives.
 *
 * Driven by the findings, confirmed by both contracts, and located in the
 * bytes. All three have to agree: the finding says the prose matters, the
 * contracts say what it was and what it became, and the file says where.
 */
export function planPatch(options: PlanOptions): PatchPlan {
  const { report, packageDir } = options;
  const edits: PatchEdit[] = [];
  const refused: PatchRefusal[] = [];
  const files = codeFiles(packageDir);

  for (const surface of report.surfaces) {
    if (!surface.from.present || !surface.to.present) continue;
    const before = toolsByName(surface.from.contract);
    const after = toolsByName(surface.to.contract);

    // One restoration per tool, however many findings point at it. Two edits
    // to the same description would have the second search for text the first
    // already replaced.
    const wanted = new Map<string, ProseFinding>();
    for (const finding of surface.prose.findings) {
      if (!RESTORABLE.has(finding.rule)) continue;
      if (!wanted.has(finding.tool)) wanted.set(finding.tool, finding);
    }

    for (const [name, finding] of wanted) {
      const scope = { tool: name, subpath: surface.subpath };

      if (finding.confidence === "unconfirmed") {
        refused.push({
          ...scope,
          reason: "not_certain",
          detail: `a rule matched but nothing checked the meaning — too weak to edit a dependency on`,
        });
        continue;
      }

      const old = before.get(name)?.description ?? null;
      const now = after.get(name)?.description ?? null;
      if (old === null || now === null) {
        refused.push({ ...scope, reason: "no_text", detail: `one side ships no description for this tool` });
        continue;
      }
      if (old === now) {
        refused.push({ ...scope, reason: "unchanged", detail: `both versions ship the same description` });
        continue;
      }

      const where = locate(now, packageDir, files);
      if (!where.found) {
        refused.push({ ...scope, reason: where.reason, detail: where.detail });
        continue;
      }

      // The replacement is encoded the same way the text it replaces was, so a
      // literal stays a valid literal. Restoring raw text into an escaped
      // string would end the literal early and break the file it was meant to
      // repair — the worst possible outcome for a tool that edits node_modules.
      const replacement = where.encoding === "raw" ? old : JSON.stringify(old).slice(1, -1);

      edits.push({
        file: where.file,
        find: where.find,
        replace: replacement,
        encoding: where.encoding,
        why: `restores the description this tool shipped at ${report.subject.from}`,
        ...scope,
      });
    }
  }

  return {
    package: report.subject.package,
    version: options.version ?? report.subject.to,
    edits,
    refused,
  };
}

export type ApplyResult = {
  file: string;
  applied: boolean;
  detail: string;
};

/**
 * Write the plan into a package directory.
 *
 * Re-checks every edit against the bytes immediately before writing rather than
 * trusting the plan. A plan can be minutes old, an install can have run in
 * between, and applying a stale edit is how a patch tool corrupts a file. If
 * the text is no longer exactly where it was, the edit is skipped and said so.
 */
export function applyPatch(plan: PatchPlan, packageDir: string): ApplyResult[] {
  const results: ApplyResult[] = [];
  const byFile = new Map<string, PatchEdit[]>();
  for (const edit of plan.edits) {
    const list = byFile.get(edit.file);
    if (list === undefined) byFile.set(edit.file, [edit]);
    else list.push(edit);
  }

  for (const [file, group] of byFile) {
    const full = join(packageDir, file);
    let contents: string;
    try {
      contents = readFileSync(full, "utf8");
    } catch (error) {
      results.push({ file, applied: false, detail: `could not read: ${String(error)}` });
      continue;
    }

    let next = contents;
    let changed = 0;
    const skipped: string[] = [];
    for (const edit of group) {
      const at = next.indexOf(edit.find);
      if (at < 0 || next.indexOf(edit.find, at + edit.find.length) >= 0) {
        skipped.push(edit.tool);
        continue;
      }
      next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
      changed += 1;
    }

    if (changed === 0) {
      results.push({ file, applied: false, detail: `nothing to change — the text was not where the plan said` });
      continue;
    }

    try {
      writeFileSync(full, next, "utf8");
    } catch (error) {
      results.push({ file, applied: false, detail: `could not write: ${String(error)}` });
      continue;
    }

    results.push({
      file,
      applied: true,
      detail:
        `restored ${changed} description(s)` +
        (skipped.length > 0 ? `; skipped ${skipped.join(", ")} — text had moved` : ""),
    });
  }

  return results;
}
