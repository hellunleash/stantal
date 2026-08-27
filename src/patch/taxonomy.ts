/**
 * Layer 6 — the patch.
 *
 * The spec's delivery ladder ranks a patch *below* a failing test, and the
 * reason is worth keeping in front of whoever changes this file: a test asks
 * the recipient to run one command and judge for themselves, while a patch asks
 * them to accept an edit to code they did not write. The second needs more
 * trust, so it is only offered where the evidence is strongest.
 *
 * **What this patches is the provider's package, not the consumer's code.**
 * When a release deletes the sentence that told a model when to pass a
 * parameter, there is nothing to fix in the calling code — the calling code was
 * always right. The wrong bytes are in `node_modules`, and restoring them is
 * the only thing that actually works while every published release carries the
 * defect. That is the `patch` remedy from Layer 4, made real.
 *
 * **Only prose is restored.** Never a schema, never a type, never a required
 * flag. Changing the shape of someone's package under their own runtime is how
 * a tool causes an outage; changing a description back cannot break a caller,
 * because no caller branches on it — only a model reads it, which is the entire
 * premise of this project.
 *
 * **Nothing is applied without being asked for.** The plan is computed and
 * printed by default. Writing into `node_modules` happens on an explicit flag.
 */

export type PatchRefusalReason =
  /** The text as shipped could not be located in any file of the package. */
  | "not_found"
  /** It appears more than once, so which occurrence to edit is a guess. */
  | "ambiguous"
  /** One side has no description to restore, or to restore over. */
  | "no_text"
  /** The two sides already agree. Nothing to do, and not a failure. */
  | "unchanged"
  /**
   * The finding is a lead rather than a fact.
   *
   * A patch is the strongest thing this tool emits, so it needs the strongest
   * evidence. An `unconfirmed` finding is a rule that matched a pattern with
   * nothing having checked the meaning, and editing a stranger's dependency on
   * that basis is indefensible.
   */
  | "not_certain";

export type PatchRefusal = {
  tool: string;
  subpath: string;
  reason: PatchRefusalReason;
  detail: string;
};

/** One exact, located, unambiguous replacement. */
export type PatchEdit = {
  /** Package-relative POSIX path. */
  file: string;
  tool: string;
  subpath: string;
  /** The bytes as they appear in the file today. */
  find: string;
  /** The bytes to put in their place. */
  replace: string;
  /**
   * How the text was encoded in the source: as written, or through a string
   * literal's escapes. Recorded because it is the part most likely to be
   * wrong, and a reader checking the patch needs to see which one matched.
   */
  encoding: "raw" | "escaped";
  why: string;
};

export type PatchPlan = {
  package: string;
  /** The version on disk — the one that would be edited. */
  version: string;
  edits: PatchEdit[];
  /** Everything that was considered and declined, with the reason. */
  refused: PatchRefusal[];
};

/**
 * Is this plan safe to apply?
 *
 * A named predicate rather than `edits.length > 0` written at each call site,
 * for the same reason `canClaimUnaffected` exists in Layer 3: it is the one
 * question that must never be answered optimistically by accident.
 */
export function canApply(plan: PatchPlan): boolean {
  return plan.edits.length > 0;
}

/**
 * The encodings a string literal's contents can take in shipped JavaScript.
 *
 * A description read out of a contract is the *evaluated* string. What sits in
 * the file is a literal, and a literal containing a newline, a quote or a
 * backtick does not match the evaluated text byte for byte. Searching only for
 * the raw form silently fails on exactly the descriptions most worth
 * restoring — the long, multi-sentence ones.
 *
 * Two forms are tried, and only one of them may match. If both do, the location
 * is ambiguous and the edit is refused rather than guessed.
 */
export function encodings(text: string): Array<{ encoding: "raw" | "escaped"; text: string }> {
  const escaped = JSON.stringify(text).slice(1, -1);
  const out: Array<{ encoding: "raw" | "escaped"; text: string }> = [{ encoding: "raw", text }];
  if (escaped !== text) out.push({ encoding: "escaped", text: escaped });
  return out;
}
