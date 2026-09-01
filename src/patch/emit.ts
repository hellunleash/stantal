import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PatchEdit, PatchPlan } from "./taxonomy.js";

/**
 * A restoration that survives `npm install`.
 *
 * `applyPatch` edits the copy in `node_modules`, which is correct and is erased
 * by the next install. That makes it a way to check a fix, not a way to keep
 * one. This renders the same edits as a `patch-package` file instead: it lives
 * in the repository, it is reviewable as a diff, and `patch-package` reapplies
 * it on every install through a `postinstall` hook the project already knows
 * how to run.
 *
 * **The edits are not recomputed here.** They come from `planPatch`, which
 * already required each one to match exactly once and refused everything it
 * could not locate unambiguously. This only changes where they are written.
 */

/** Lines of unchanged text kept either side of a change, as `git diff` does. */
const CONTEXT = 3;

/** `@scope/name` at `1.2.3` -> `@scope+name+1.2.3.patch`, which is what patch-package looks for. */
export function patchFileName(pkg: string, version: string): string {
  return `${pkg.replace(/\//g, "+")}+${version}.patch`;
}

type Change = {
  /** 0-based line index in the original file. */
  start: number;
  oldLines: string[];
  newLines: string[];
};

/**
 * Where one edit lands, in the original file's coordinates.
 *
 * Located in the **original** text rather than in the partially-edited text,
 * so two edits to one file cannot shift each other's line numbers. `planPatch`
 * guarantees each `find` occurs exactly once there, which is what makes a plain
 * `indexOf` safe.
 */
function locate(original: string, edit: PatchEdit): Change | null {
  const at = original.indexOf(edit.find);
  if (at === -1) return null;

  // Widen to whole lines. A unified diff replaces lines, not byte ranges, and a
  // description literal routinely sits mid-line among other properties.
  const lineStart = original.lastIndexOf("\n", at) + 1;
  const afterFind = at + edit.find.length;
  const nextBreak = original.indexOf("\n", afterFind);
  const lineEnd = nextBreak === -1 ? original.length : nextBreak;

  const oldBlock = original.slice(lineStart, lineEnd);
  const newBlock =
    original.slice(lineStart, at) + edit.replace + original.slice(afterFind, lineEnd);

  return {
    start: countLines(original, lineStart),
    oldLines: oldBlock.split("\n"),
    newLines: newBlock.split("\n"),
  };
}

function countLines(text: string, upTo: number): number {
  let n = 0;
  for (let i = 0; i < upTo; i += 1) if (text[i] === "\n") n += 1;
  return n;
}

/**
 * Changes close enough that their context windows touch become one hunk.
 *
 * Emitting them separately would produce overlapping context, which is not a
 * valid unified diff and which `git apply` rejects.
 */
function merge(changes: readonly Change[], lines: readonly string[]): Change[] {
  const sorted = [...changes].sort((a, b) => a.start - b.start);
  const out: Change[] = [];

  for (const change of sorted) {
    const last = out[out.length - 1];
    if (last === undefined) {
      out.push({ ...change, oldLines: [...change.oldLines], newLines: [...change.newLines] });
      continue;
    }

    const lastEnd = last.start + last.oldLines.length;
    // Far enough apart to stand alone, or overlapping — which `planPatch`'s
    // one-restoration-per-tool rule should already prevent. Either way, do not
    // try to be clever: a separate hunk is always valid.
    if (change.start > lastEnd + CONTEXT * 2 || change.start < lastEnd) {
      out.push({ ...change, oldLines: [...change.oldLines], newLines: [...change.newLines] });
      continue;
    }

    // Close enough that their context would overlap. Absorb, carrying the
    // untouched lines between them through both sides unchanged.
    const between = lines.slice(lastEnd, change.start);
    last.oldLines.push(...between, ...change.oldLines);
    last.newLines.push(...between, ...change.newLines);
  }
  return out;
}

/** What a diff says about a file whose last line has no line ending. */
const NO_EOL = "\\ No newline at end of file";

/** One file's edits, as unified-diff hunks. */
function hunksFor(original: string, edits: readonly PatchEdit[]): string[] {
  // A file ending in a newline splits to a trailing empty element that is not a
  // line. Counting it would put a phantom blank context line in every hunk that
  // reaches the end of the file, and git would refuse the patch.
  const endsWithNewline = original.endsWith("\n");
  const raw = original.split("\n");
  const lines = endsWithNewline ? raw.slice(0, -1) : raw;
  const lastIndex = lines.length - 1;

  const located = edits.map((edit) => locate(original, edit)).filter((c): c is Change => c !== null);
  if (located.length === 0) return [];

  const changes = merge(located, lines);
  const out: string[] = [];
  let delta = 0;

  for (const change of changes) {
    const { oldLines, newLines } = change;
    const before = lines.slice(Math.max(0, change.start - CONTEXT), change.start);
    const afterFrom = change.start + oldLines.length;
    const after = lines.slice(afterFrom, afterFrom + CONTEXT);

    const oldStart = change.start - before.length + 1;
    const oldCount = before.length + oldLines.length + after.length;
    const newCount = before.length + newLines.length + after.length;

    // The marker sits under whichever line is genuinely last in the file. When
    // a trailing context line is last it belongs to both sides once; when the
    // change itself runs to the end, each side needs its own.
    const contextRunsToEnd = after.length > 0 && afterFrom + after.length - 1 === lastIndex;
    const changeRunsToEnd = after.length === 0 && change.start + oldLines.length - 1 === lastIndex;
    const mark = !endsWithNewline;

    const body: string[] = [
      ...before.map((l) => ` ${l}`),
      ...oldLines.map((l) => `-${l}`),
      ...(mark && changeRunsToEnd ? [NO_EOL] : []),
      ...newLines.map((l) => `+${l}`),
      ...(mark && changeRunsToEnd ? [NO_EOL] : []),
      ...after.map((l) => ` ${l}`),
      ...(mark && contextRunsToEnd ? [NO_EOL] : []),
    ];

    out.push(`@@ -${oldStart},${oldCount} +${oldStart + delta},${newCount} @@\n${body.join("\n")}`);
    delta += newCount - oldCount;
  }

  return out;
}

export type RenderedPatch = {
  /** The file's contents, ready to write. */
  text: string;
  /** Package-relative paths the patch touches. */
  files: string[];
  /** Suggested filename, as patch-package resolves it. */
  name: string;
};

/**
 * The whole plan as one patch file, or null when it would be empty.
 *
 * Null rather than an empty patch: a zero-hunk file that `patch-package`
 * silently accepts would read as a restoration that is in place, and there
 * would be nothing to notice when it was not.
 */
export function renderPatchFile(plan: PatchPlan, packageDir: string): RenderedPatch | null {
  const byFile = new Map<string, PatchEdit[]>();
  for (const edit of plan.edits) {
    const list = byFile.get(edit.file);
    if (list === undefined) byFile.set(edit.file, [edit]);
    else list.push(edit);
  }

  const sections: string[] = [];
  const files: string[] = [];

  for (const [file, edits] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    let original: string;
    try {
      original = readFileSync(join(packageDir, file), "utf8");
    } catch {
      // A file we cannot read is dropped rather than guessed at. Every edit in
      // it stays in `plan.edits`, so the caller can still see what was intended.
      continue;
    }

    const hunks = hunksFor(original, edits);
    if (hunks.length === 0) continue;

    // patch-package addresses files from the project root, through
    // `node_modules`, which is also how it finds them again on reinstall.
    const path = `node_modules/${plan.package}/${file}`;
    sections.push(
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n"),
    );
    files.push(file);
  }

  if (sections.length === 0) return null;

  return {
    text: `${sections.join("\n")}\n`,
    files,
    name: patchFileName(plan.package, plan.version),
  };
}
