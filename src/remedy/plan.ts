import type { HistoryResult, Onset } from "../history.js";
import type { Remedy, RemedyKind } from "./taxonomy.js";

export type RemedyOptions = {
  walk: HistoryResult;
  /**
   * The version the consumer is on now.
   *
   * Left unset, the oldest release walked is assumed, which is the stranded
   * case the product exists for. A version outside the walk is reported as
   * `unknown` rather than resolved to the nearest thing that looks like it.
   */
  current?: string;
  /**
   * Whether the consumer's own code has to change too.
   *
   * Comes from Layer 3: a reach into their call sites means the upgrade is not
   * free. Left unset, the answer stays on the provider's side of the table,
   * which is the honest default — a prose defect in someone else's package is
   * never fixable in your code, and most findings here are prose.
   */
  callSitesAffected?: boolean;
};

/** Does this onset cover this version? */
function covers(onset: Onset, version: string, order: readonly string[]): boolean {
  const at = order.indexOf(version);
  const from = order.indexOf(onset.introducedAt);
  if (at < 0 || from < 0 || at < from) return false;
  if (onset.resolvedAt === null) return true;
  const until = order.indexOf(onset.resolvedAt);
  return until < 0 || at < until;
}

/**
 * Compare by walk order, not by semver.
 *
 * The walk already resolved and sorted the release list, and re-deriving order
 * here would let two different orderings disagree inside one report. It also
 * means a package with dates for versions works the same as one with semver.
 */
function indexOf(order: readonly string[], version: string): number {
  return order.indexOf(version);
}

/**
 * What to do about it.
 *
 * Reads a completed history walk, so it costs nothing: every fact it needs was
 * already measured, and this layer only decides.
 */
export function planRemedy(options: RemedyOptions): Remedy {
  const { walk, callSitesAffected = false } = options;
  const order = walk.versions;
  const latest = order.length > 0 ? (order[order.length - 1] ?? null) : null;

  const referenced = (onsets: readonly Onset[]) =>
    onsets.map((o) => ({ key: o.key, rule: o.rule, target: o.target, subpath: o.subpath }));

  if (order.length === 0) {
    return {
      kind: "unknown",
      target: null,
      latest,
      headline: "no releases were walked, so there is nothing to recommend",
      because: [],
      unverifiable: [],
    };
  }

  const current = options.current ?? order[0]!;
  if (indexOf(order, current) < 0) {
    // Not resolved to something nearby. A recommendation computed against a
    // version that was never walked is a guess wearing a version number.
    return {
      kind: "unknown",
      target: null,
      latest,
      headline: `${current} is not among the releases walked, so no hop can be checked`,
      because: [],
      unverifiable: [],
    };
  }

  // A release nobody could read is not a clean release. Silence from a failed
  // extraction and silence from a clean contract look identical, and only one
  // of them is safe to move into.
  const unreadable = new Set(
    walk.steps.filter((s) => s.unreadableSurfaces.length > 0).map((s) => s.version),
  );

  const carried = (version: string) => walk.onsets.filter((o) => covers(o, version, order));

  const currentOnsets = carried(current);
  const currentIndex = indexOf(order, current);

  // Forward only. A consumer is asking whether to take an upgrade, and
  // recommending a downgrade answers a question nobody asked — the older
  // release has its own accumulated deltas that were never measured here.
  const ahead = order.slice(currentIndex + 1);
  const skipped: string[] = [];
  let nearest: string | null = null;
  for (const version of ahead) {
    if (unreadable.has(version)) {
      skipped.push(version);
      continue;
    }
    if (carried(version).length === 0) {
      nearest = version;
      break;
    }
  }

  const hold = {
    package: walk.package,
    heldAt: current,
    stillPresentAt: latest ?? current,
    until: referenced(currentOnsets),
  };

  if (currentOnsets.length === 0) {
    // Clean where they stand and nothing ahead is clean: the stranded case, and
    // the one this product exists for. Reporting it as `stay` would be true
    // about the bytes they are running and would hide that the exit is closed.
    // What they need is the predicate that says why, so the hold lifts itself
    // when a later release clears it.
    const blocking = ahead.flatMap((v) => carried(v));
    if (nearest === null && ahead.length > 0 && blocking.length > 0) {
      const distinct = [...new Map(blocking.map((o) => [o.key, o])).values()];
      return {
        kind: "stuck",
        target: null,
        latest,
        headline:
          `${current} is clean, but every release after it carries ` +
          `${distinct.length} finding${distinct.length === 1 ? "" : "s"} — there is nowhere to upgrade to`,
        because: referenced(distinct),
        hold: { ...hold, until: referenced(distinct) },
        unverifiable: skipped,
      };
    }

    return {
      kind: "stay",
      target: null,
      latest,
      headline:
        ahead.length === 0
          ? `${current} is clean and is the newest release`
          : `${current} is already clean`,
      because: [],
      unverifiable: skipped,
    };
  }

  const kind: RemedyKind =
    nearest !== null ? (callSitesAffected ? "migrate" : "upgrade") : callSitesAffected ? "fix_locally" : "patch";

  const count = currentOnsets.length;
  const noun = `${count} finding${count === 1 ? "" : "s"}`;

  // Nearest, never latest. A consumer stranded twenty releases back is not
  // taking one change; they are taking the accumulated delta of twenty. The
  // useful answer is the smallest hop that clears the reason they are stuck.
  const headline =
    nearest !== null
      ? `${nearest} is the nearest release clean of ${noun}` +
        (latest !== null && latest !== nearest ? ` (latest is ${latest})` : "") +
        (callSitesAffected ? "; your call sites move too" : "")
      : callSitesAffected
        ? `no release is clean of ${noun}; the change is in how you call it`
        : `no release is clean of ${noun}; the defect is in the package, so patching is the only thing that works`;

  return {
    kind,
    target: nearest,
    latest,
    headline,
    because: referenced(currentOnsets),
    // A hold rides along whenever staying is still on the table. `patch` and
    // `fix_locally` mean the consumer is not moving, and a pin with no recorded
    // predicate is a pin nobody revisits.
    ...(nearest === null ? { hold } : {}),
    unverifiable: skipped,
  };
}
