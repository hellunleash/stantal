import type { FindingKey } from "../history.js";

/**
 * Layer 4 — remedy.
 *
 * Layers 0 to 3 end at "this changed, a model reads it differently, and it
 * reaches these lines of yours". A consumer standing in front of that still has
 * to decide what to do, and the honest answer is not always the same one.
 *
 * **Remedy is not a ladder.** It is the answer to two questions:
 *
 *   Q1 — is there a version where this contract is clean for you?
 *   Q2 — whose artifact is the defect in?
 *
 * |                          | a clean version exists | none exists |
 * |--------------------------|------------------------|-------------|
 * | the provider's artifact  | upgrade                | patch       |
 * | your own call sites      | upgrade and migrate    | fix locally |
 *
 * Two properties this layer must have, and both are about what it refuses to
 * say rather than what it says.
 *
 * **"There is no clean version" is a real answer.** A nearest-clean search that
 * cannot return empty will invent a recommendation, and a fabricated version
 * number is worse than silence: it is checkable, it fails, and it takes the
 * rest of the report's credibility with it.
 *
 * **A version we could not read is not a clean version.** Silence from a failed
 * extraction looks exactly like silence from a clean contract, and only one of
 * them is safe to upgrade into. Recommending a hop into a release nobody could
 * read would be the single worst output this product could produce.
 */

export type RemedyKind =
  /** Already clean, and there is a way forward if you want one. Nothing to do. */
  | "stay"
  /**
   * Clean where you stand, and every release ahead carries something.
   *
   * The stranded case, and the one this product was built for. It is not
   * `stay`: nothing is wrong with the version in use, but the consumer cannot
   * move, and telling them "you are fine" hides that the exit is closed. It is
   * not `patch` either, because there is nothing to patch yet — the bytes they
   * are running are correct.
   *
   * What they need is the hold: the predicate that says why the upgrade is
   * blocked, re-checked on every later release so it lifts itself.
   */
  | "stuck"
  /** A clean release exists ahead. Take the smallest hop that reaches it. */
  | "upgrade"
  /**
   * A clean release exists, but your own call sites move too.
   *
   * The upgrade is still the answer; it just is not free. Separated from
   * `upgrade` because a consumer budgets for them differently, and being told
   * "just upgrade" about a change that breaks your code is how a tool loses
   * someone's trust in one step.
   */
  | "migrate"
  /**
   * No release is clean, and the wrong bytes are in the provider's package.
   *
   * You cannot fix this in your own code, and upgrading cannot help because
   * every version carries it. A local patch is the only thing that works.
   */
  | "patch"
  /**
   * No release is clean, and the change is in how you call it.
   *
   * Rare, and kept distinct from `patch` because the work lands in a different
   * repository and on a different person.
   */
  | "fix_locally"
  /**
   * Not enough was read to recommend anything.
   *
   * A separate kind rather than a missing field. A caller that has to check
   * whether `target` is null before trusting `kind` will eventually forget, and
   * the failure mode is recommending an upgrade nobody verified.
   */
  | "unknown";

/**
 * The reason a pin exists, in a form a machine can re-check.
 *
 * **A pin is a hold, not a remedy.** It stops the bleeding and changes nothing
 * about the defect. What makes it survivable is that the reason is written down
 * as a predicate rather than a comment: every later release is checked against
 * it, and the hold lifts itself the moment one comes back clean.
 *
 * Pins nobody revisits are how consumers get stranded in the first place, and a
 * pin with a prose comment is a pin nobody revisits.
 */
export type Hold = {
  package: string;
  /** The version being held at. */
  heldAt: string;
  /** The newest release checked that did not clear the hold. */
  stillPresentAt: string;
  /**
   * What has to go away before the hold lifts. Keyed, not described, so a later
   * walk compares them rather than a human re-reading a sentence.
   */
  until: Array<{ key: FindingKey; rule: string; target: string; subpath: string }>;
};

export type Remedy = {
  kind: RemedyKind;
  /**
   * The version to move to, or null when there is none to name.
   *
   * Null on `stay`, `patch`, `fix_locally` and `unknown`. Never a guess.
   */
  target: string | null;
  /** The newest release walked, so "nearest" can be read against "latest". */
  latest: string | null;
  /** One line a human acts on. Derived, never written by a model. */
  headline: string;
  /** The findings that produced this answer, so it can be checked. */
  because: Array<{ key: FindingKey; rule: string; target: string; subpath: string }>;
  /** Set whenever staying put is part of the answer. */
  hold?: Hold;
  /**
   * Releases skipped when searching, because too little of them could be read
   * to call them clean. Reported, because a hop the search declined to
   * recommend for that reason is a different answer from one it never saw.
   */
  unverifiable: string[];
};

/** Does a remedy actually move the consumer anywhere? */
export function movesVersion(remedy: Remedy): boolean {
  return remedy.kind === "upgrade" || remedy.kind === "migrate";
}
