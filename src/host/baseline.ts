import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { BASELINE_DIR, baselineSlug, type HostContract } from "./discover.js";

/**
 * The baseline: what this repo's own contract looked like last time.
 *
 * A generated contract has no version. Nothing about it is ordered — no
 * registry, no tag, no semver range — so there is no pair to compare and every
 * other entry point in this tool has nothing to work with. A snapshot supplies
 * the missing half: with one on disk, the next regeneration is an ordinary
 * before/after, read by the same extractor and folded into the same verdict.
 *
 * That is what makes the failure detectable at all. On a real host, two runs
 * hours apart on unchanged code produced 50 tools with almost no parameters and
 * 50 tools with 221 fields. Semver saw nothing, the type-checker saw nothing,
 * and the test suite saw nothing, because nothing they watch had moved.
 *
 * **Documents are stored as files, not as escaped text inside one.** The point
 * of committing a baseline is that a person can read the diff, and a JSON
 * string holding a whole document diffs as one unreadable line.
 */

/** What a stored baseline records about itself. */
export type BaselineMeta = {
  savedAt: string;
  /** The catalog path this snapshots, so a slug collision is caught rather than overwritten. */
  catalog: string;
  /** Stored filenames, in merge order, alongside the repo path each came from. */
  sources: { path: string; file: string }[];
};

export type LoadedBaseline = {
  meta: BaselineMeta;
  sources: { text: string; origin: string }[];
};

const META = "stantal.json";

function dirFor(root: string, catalog: string): string {
  return join(root, BASELINE_DIR.split("/").join(sep), baselineSlug(catalog));
}

/**
 * Is the whole of `.stantal/` ignored here?
 *
 * A baseline that is not committed is a baseline only the machine that saved it
 * has, which quietly turns a shared check into a personal one: CI and every
 * teammate compare against nothing. Worth one line of `.gitignore` reading,
 * because the failure is silent and this project's own `.gitignore` has that
 * rule in it for an unrelated reason, so somebody will copy it.
 */
export function baselineWouldBeIgnored(root: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(root, ".gitignore"), "utf8");
  } catch {
    return false;
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === ".stantal" || line === ".stantal/" || line === ".stantal/*");
}

/** Repo-relative path of a baseline, for messages a user has to act on. */
export function baselinePath(catalog: string): string {
  return `${BASELINE_DIR}/${baselineSlug(catalog)}`;
}

/**
 * Read the stored baseline for a contract, or null when there is none.
 *
 * Null is "never saved" and must stay distinguishable from an empty contract:
 * one means there is nothing to compare against yet, the other means every tool
 * was removed.
 */
export function readBaselineMeta(root: string, catalog: string): BaselineMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(dirFor(root, catalog), META), "utf8")) as BaselineMeta;
    return Array.isArray(meta.sources) && meta.sources.length > 0 ? meta : null;
  } catch {
    return null;
  }
}

export function loadBaseline(root: string, catalog: string): LoadedBaseline | null {
  const dir = dirFor(root, catalog);
  const meta = readBaselineMeta(root, catalog);
  if (meta === null) return null;

  const sources: { text: string; origin: string }[] = [];
  for (const entry of meta.sources) {
    // A missing document is a broken baseline, not an empty one. Comparing
    // against the half that survived would report every tool of the missing
    // document as gone.
    const text = readFileSync(join(dir, entry.file), "utf8");
    sources.push({ text, origin: entry.path });
  }
  return { meta, sources };
}

/**
 * Write the baseline for one contract.
 *
 * Overwrites deliberately: a baseline is a moving record of "what it was last
 * time we looked", and saving is the step the user explicitly asks for. That is
 * the opposite of `pin`, which refuses to overwrite, because a pinned suite
 * carries assertions that were about to fail and re-recording them would erase
 * the protection it was run to provide. Here there is nothing to erase — the
 * old snapshot is in git.
 */
export function saveBaseline(
  root: string,
  contract: HostContract,
  read: (path: string) => string | null,
): { path: string; files: string[] } {
  const dir = dirFor(root, contract.catalog);

  // Meta only: a baseline whose documents are half missing is still a baseline,
  // and reading them here would turn "your snapshot is damaged" into a failure
  // to save a new one.
  const existing = readBaselineMeta(root, contract.catalog);
  if (existing !== null && existing.catalog !== contract.catalog) {
    // Two different contracts slugged the same way. Refused rather than
    // resolved: silently overwriting would replace one host's baseline with
    // another's, and the next run would report every tool of both as changed.
    throw new Error(
      `${baselinePath(contract.catalog)} already holds a baseline for ${existing.catalog}. ` +
        `Move or delete it before saving ${contract.catalog}.`,
    );
  }

  const sources: { path: string; file: string }[] = [];
  const texts: string[] = [];
  for (const [index, path] of contract.sources.entries()) {
    const text = read(path);
    if (text === null) throw new Error(`cannot read ${path}`);
    sources.push({ path, file: `${index}-${path.split("/").pop() ?? "document.json"}` });
    texts.push(text);
  }

  mkdirSync(dir, { recursive: true });

  // Documents that are no longer part of this contract are removed, so a
  // baseline never holds a stale half of a merge that a later load would
  // silently read back in.
  const keep = new Set([META, ...sources.map((s) => s.file)]);
  for (const name of readdirSync(dir)) {
    if (!keep.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }

  const meta: BaselineMeta = { savedAt: new Date().toISOString(), catalog: contract.catalog, sources };
  writeFileSync(join(dir, META), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  for (const [index, entry] of sources.entries()) {
    writeFileSync(join(dir, entry.file), texts[index] ?? "", "utf8");
  }

  return { path: baselinePath(contract.catalog), files: sources.map((s) => s.file) };
}
