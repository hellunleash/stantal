/**
 * Layer 3 — blast radius.
 *
 * Layers 0 to 2 answer "did this contract change, and would a model read it
 * differently". That is a fact about the *package*, and it is the same fact for
 * everyone. This layer answers the only question a particular consumer has:
 * **does any of it reach me.**
 *
 * The filter matters more than the finding. A backfill produced 168 findings
 * across 22 packages; a consumer who depends on two of them, imports one door
 * of each, and pins inside a clean range is touched by almost none. Handing
 * them all 168 is the same as handing them none — they cannot tell which line
 * to open. A reach carries a `file:line` precisely so they can.
 *
 * **This is the first layer that reads the consumer's own code**, which is why
 * it is last. Everything before it works on published bytes and needs no
 * access to anything private.
 *
 * The invariant that governs the whole layer: **"we did not find it" is not
 * "it is not there".** A repo we could not read must never present as a repo
 * nothing reaches. That is the same rule the extractor is built around, and it
 * is more dangerous here, because the output of this layer is what a consumer
 * uses to decide they are safe.
 */

export type ReachKind =
  /**
   * A trace shows this tool being called.
   *
   * The only reach in this layer that is not inference. Everything else here
   * argues from what the repository *could* do — it declares the dependency, it
   * opens the door, it names the tool. This one is a record of what happened,
   * which is why it ranks first.
   *
   * **It can add a reach and can never remove one.** A tool absent from a trace
   * is a tool nobody called in the window that was exported, which is not the
   * same as a tool nobody calls. Letting a short trace file clear a finding
   * would be the exact false clearance this project exists to prevent.
   */
  | "observed_call"
  /**
   * The manifest depends on the package, and the declared range admits a
   * version the finding is present in. Range, not installed version: a caret
   * range that resolves clean today will pick up the defect on the next
   * install, and a consumer deciding whether they are exposed needs to know
   * that before it happens.
   */
  | "dependency"
  /**
   * The repo imports the exact door the finding sits on.
   *
   * The sharpest filter in the layer. One package routinely exposes several
   * surfaces carrying different contracts, and a finding on a door you never
   * open cannot reach you however true it is.
   */
  | "surface_import"
  /** The repo names an affected tool. */
  | "tool_reference"
  /**
   * The repo names an affected parameter, in a file that already names its
   * tool.
   *
   * Scoped that way on purpose. Parameter names are ordinary words — `app`,
   * `context`, `limit` — and matching them across a whole repo would return
   * every file and mean nothing. A match only counts where the surrounding
   * file is demonstrably about that tool.
   */
  | "param_reference"
  /**
   * The repo mounts the door this finding sits on, and **no source file names
   * the tool**. The caller here is the model, not the code.
   *
   * The kind exists because of a failure this layer had on a real repository:
   * a project imported the package in three files and Layer 3 said nothing
   * about the finding, because the tools it sat on appear in no source line.
   * Under this project's own thesis that is not a rare corner. A contract
   * consumed by a model is *usually* named nowhere in the consumer's code —
   * the code hands the whole pack over and the model picks a tool at runtime.
   * So the sharpest evidence this layer has, a `tool_reference`, is missing
   * exactly when the product's central claim is most true, and silence there
   * reads as "you are unaffected".
   *
   * It is emitted only where a mount was actually found, so it never stands in
   * for "we did not look". Its evidence is the mount site: the line that hands
   * this contract to a model is the line a consumer has to open, since there
   * is no other.
   */
  | "model_consumer";

export type Reach = {
  kind: ReachKind;
  /** What was reached: a package, a subpath, a tool, or `tool.param`. */
  target: string;
  /** `src/agent.ts:42`, or a manifest path. Every claim is checkable. */
  evidence: string;
  detail: string;
};

/**
 * A finding that cannot reach this consumer, and the reason.
 *
 * Reported rather than dropped. "We looked and it does not touch you" and "we
 * never looked" are opposite claims, and a filter that quietly removed things
 * would make them indistinguishable — which is exactly how a consumer ends up
 * believing they are safe.
 */
/**
 * Why a real finding cannot reach this consumer.
 *
 * A machine-readable kind alongside the sentence, because callers branch on
 * this. "Your declared range already excludes it" and "you never import that
 * door" lead to different advice, and matching on the wording of a sentence to
 * tell them apart is a bug waiting for the day somebody improves the wording.
 */
export type FilteredKind =
  /** The manifest names the package, and the declared range admits no affected version. */
  | "range_excludes"
  /** There is a manifest and it does not name the package at all. */
  | "not_a_dependency"
  /** The repo imports this package, but never the subpath the finding sits on. */
  | "subpath_not_imported";

export type Filtered = {
  target: string;
  kind: FilteredKind;
  reason: string;
};

/** Something the scan could not read, which narrows what the result may claim. */
export type BlastNote = {
  /** `package.json`, a file path, or a glob that matched nothing. */
  where: string;
  detail: string;
};

export type BlastResult = {
  reaches: Reach[];
  filtered: Filtered[];
  /**
   * Gaps in the reading. **A non-empty `notes` means `reaches` is a floor, not
   * a total**, and no caller may report "not affected" off the back of it.
   */
  notes: BlastNote[];
  scanned: { files: number; bytes: number };
};

/**
 * Is this result strong enough to support "nothing reaches you"?
 *
 * The one question the layer must never get wrong in the optimistic direction,
 * so it is a named function rather than a `notes.length === 0` written out at
 * each call site and eventually forgotten at one of them.
 */
export function canClaimUnaffected(result: BlastResult): boolean {
  return result.notes.length === 0 && result.reaches.length === 0;
}

/** Worst first, so the line a consumer reads first is the one that matters most. */
const RANK: Record<ReachKind, number> = {
  // First: the one line here that is a record rather than an argument.
  observed_call: 0,
  dependency: 1,
  surface_import: 2,
  tool_reference: 3,
  param_reference: 4,
  // Last: real, and the least checkable thing here. A consumer scanning the
  // list wants the lines naming a tool before the line that only mounts one.
  model_consumer: 5,
};

export function compareReaches(a: Reach, b: Reach): number {
  return RANK[a.kind] - RANK[b.kind] || a.target.localeCompare(b.target) || a.evidence.localeCompare(b.evidence);
}
