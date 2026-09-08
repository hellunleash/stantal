import type { HistoryResult } from "./history.js";

/**
 * How much of a provider's installed base is sitting on an affected release.
 *
 * The one number a provider cannot get anywhere else, and the one they can get
 * **with no access to any user at all**. Two public inputs, multiplied:
 *
 * 1. `stantal history`, which walks every published release and records where
 *    each finding was introduced and whether it was ever resolved;
 * 2. npm's per-version download counts, which are public for every package.
 *
 * Crossed, they give the sentence nobody else can write: *this share of the
 * people installing you this week are on a version whose contract a model reads
 * differently, and here is the release that did it.*
 *
 * Nothing new is measured here. It is two things that already exist, joined.
 *
 * ### The honesty rule, and it is the important part
 *
 * This is the **unbiased** number. Every install of the package is in the
 * denominator whether or not anyone ran anything, because npm counts them all.
 *
 * There is a second number a provider will eventually want — of the consumers
 * who ran a check, how many actually name the thing that moved. That one comes
 * from an opted-in sample, so it is "of the installs we heard from", never "of
 * your installs". **The two must never be multiplied together.** One is a
 * census and the other is a self-selected survey, and their product is a number
 * about no population that exists.
 *
 * A tool that cannot return zero cannot be believed when it returns 100, so the
 * zero case is worth checking before quoting the high one: measured 2026-09-03,
 * `firecrawl-mcp` was 100.0% of 36,885 installs and `tavily-mcp` 0.0% of 17,633.
 */

export type ExposureState =
  /** This release carries at least one finding. */
  | "affected"
  /** The walk read this release and found nothing. */
  | "clean"
  /**
   * Downloaded, and not in the walk.
   *
   * Counted as neither. A release the walk did not cover is not a release we
   * cleared, and folding it into either side would be a claim nobody measured.
   */
  | "not-walked";

export type ExposureRow = {
  version: string;
  downloads: number;
  state: ExposureState;
};

export type ExposureResult = {
  package: string;
  /** How many releases the walk covered. */
  releases: number;
  /** Every version with installs in the window, most-installed first. */
  rows: ExposureRow[];
  /** Installs on a release carrying a finding. */
  affected: number;
  /** Installs on a release the walk read and cleared. */
  clean: number;
  /** Installs on a release the walk did not cover. In neither of the above. */
  unwalked: number;
  /** `affected / (affected + clean)`, or null when nothing was counted. */
  share: number | null;
  /** The download window these counts come from. */
  window: string;
  generatedAt: string;
};

/**
 * Pure, so it can be tested without the network and re-run on a saved walk.
 *
 * A release counts as affected when it carries at least one finding. Say that
 * precisely when quoting it: `firecrawl-mcp` at 100% means every release
 * carries *at least one* of its findings, not that every release carries all
 * 102 of them.
 */
export function exposureOf(
  history: HistoryResult,
  downloads: Readonly<Record<string, number>>,
  window = "last-week",
): ExposureResult {
  const affectedAt = new Map(history.steps.map((s) => [s.version, s.findings > 0]));

  let affected = 0;
  let clean = 0;
  let unwalked = 0;
  const rows: ExposureRow[] = [];

  for (const [version, downloadsFor] of Object.entries(downloads)) {
    const known = affectedAt.get(version);
    const state: ExposureState = known === undefined ? "not-walked" : known ? "affected" : "clean";
    if (state === "affected") affected += downloadsFor;
    else if (state === "clean") clean += downloadsFor;
    else unwalked += downloadsFor;
    rows.push({ version, downloads: downloadsFor, state });
  }

  rows.sort((a, b) => b.downloads - a.downloads || a.version.localeCompare(b.version));
  const counted = affected + clean;

  return {
    package: history.package,
    releases: history.versions.length,
    rows,
    affected,
    clean,
    unwalked,
    share: counted === 0 ? null : affected / counted,
    window,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * npm's public per-version download counts.
 *
 * Their endpoint, not ours. Nothing about this needs an account, a key, or a
 * server of our own, which is why it belongs in the open CLI rather than behind
 * the hosted line: the rule is whether a thing needs *our* credential, and this
 * needs nobody's.
 *
 * An empty object on failure, never a throw. The walk above it is the expensive
 * part and is already done by this point; losing it because a download endpoint
 * was slow would be the wrong trade. The caller reports the gap.
 */
export async function fetchDownloads(pkg: string, window = "last-week"): Promise<Record<string, number>> {
  const url = `https://api.npmjs.org/versions/${encodeURIComponent(pkg)}/${window}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`npm returned ${response.status} for ${url}`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object") return {};
  const counts = (body as { downloads?: unknown }).downloads;
  if (counts === null || typeof counts !== "object") return {};

  const out: Record<string, number> = {};
  for (const [version, value] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[version] = value;
  }
  return out;
}
