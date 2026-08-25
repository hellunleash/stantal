/**
 * Layer 2 — what a behavioural finding is allowed to say.
 *
 * Layer 1 reads the contract and reasons about what a model *would* do. This
 * layer watches what a model *does*, across two versions, and reports the
 * difference. The same discipline applies for the same reason: a free-text
 * summary of "the model seemed less sure" is not something a CI job can branch
 * on, so the output is a closed enum with evidence attached.
 *
 * One rule shapes every decision in this file. **Model output is stochastic, so
 * a single differing run is not a finding.** Every intent runs k times against
 * each side and a rule fires only when the difference survives a confidence
 * interval. A verdict that flips on rerun is worse than no verdict at all.
 */

export type BehaviourRule =
  /** The model picked a different tool for the same request. */
  | "tool_switched"
  /** The model started filling an optional field it used to leave out. */
  | "optional_field_appeared"
  /** The model stopped filling an optional field it used to fill. */
  | "optional_field_dropped"
  /**
   * The model puts a value in a field the older version did not declare.
   *
   * Distinct from `optional_field_appeared`, which is about a field both
   * versions declare. Here there was nothing to fill before, so the older
   * behaviour is not a sample that could have gone either way — which is why
   * seeing it happen once is proof it *can* happen, even when k is far too
   * small to say how often. That claim is reported `underpowered`.
   */
  | "new_field_used"
  /** The model stopped calling any tool for a request it used to serve. */
  | "call_abandoned"
  /** The model started calling a tool for a request it used to decline. */
  | "call_introduced"
  /** The arguments stopped satisfying the contract's own declared schema. */
  | "arguments_invalid";

export type Severity = "high" | "medium" | "low";

/**
 * How much the finding rests on.
 *
 * `measured` means both sides ran the full k and the intervals do not overlap.
 * `underpowered` means the difference is real in the samples taken but k was too
 * small to separate it from noise — reported, and labelled, never promoted.
 *
 * Most rules only produce a candidate once the intervals separate, so they are
 * `measured` unless the two sides ran a different number of times. The
 * exception is `new_field_used`: a field that did not exist cannot have been
 * filled by chance, so one observation is worth reporting while still being far
 * too little to state a rate.
 */
export type Basis = "measured" | "underpowered";

/** A proportion with the interval that decides whether it may be compared. */
export type Rate = {
  /** How many of the k runs showed the behaviour. */
  hits: number;
  /** How many runs were made. */
  runs: number;
  /** Wilson lower and upper bound, 0..1. */
  low: number;
  high: number;
};

export type BehaviourFinding = {
  rule: BehaviourRule;
  /** `tool` or `tool.param`, matching Layer 1 so a report can join them. */
  target: string;
  tool: string;
  severity: Severity;
  basis: Basis;
  headline: string;
  evidence: {
    /** The request that produced the difference, verbatim. */
    intent: string;
    intentId: string;
    before: Rate;
    after: Rate;
    /** A sample of the arguments from each side, for a human to read. */
    beforeSample: unknown;
    afterSample: unknown;
  };
};

const SEVERITY: Record<BehaviourRule, Severity> = {
  // A model that silently routes to a different code path is the failure this
  // product exists to catch, and it is invisible to every type checker.
  optional_field_appeared: "high",
  new_field_used: "high",
  tool_switched: "high",
  call_abandoned: "high",
  arguments_invalid: "high",
  optional_field_dropped: "medium",
  call_introduced: "medium",
};

export function severityOf(rule: BehaviourRule): Severity {
  return SEVERITY[rule];
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function compareFindings(a: BehaviourFinding, b: BehaviourFinding): number {
  const bySeverity = ORDER[a.severity] - ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  // Measured before underpowered, so the strongest evidence reads first.
  if (a.basis !== b.basis) return a.basis === "measured" ? -1 : 1;
  return a.target.localeCompare(b.target);
}

/**
 * Wilson score interval for a proportion.
 *
 * Chosen over the textbook normal approximation because the interesting cases
 * here sit at the edges — a field filled 0 times out of 5, or 5 out of 5. The
 * normal approximation gives a zero-width interval at both ends, which would
 * report every 0-vs-1 flip as certain no matter how few runs were made. Wilson
 * stays honest at the boundary, which is the only place this measurement lives.
 *
 * z = 1.96, the 95% two-sided normal quantile.
 */
const Z = 1.96;

export function wilson(hits: number, runs: number): Rate {
  if (runs <= 0) return { hits, runs, low: 0, high: 1 };

  const p = hits / runs;
  const z2 = Z * Z;
  const denominator = 1 + z2 / runs;
  const centre = (p + z2 / (2 * runs)) / denominator;
  const spread = (Z * Math.sqrt((p * (1 - p)) / runs + z2 / (4 * runs * runs))) / denominator;

  return {
    hits,
    runs,
    low: Math.max(0, centre - spread),
    high: Math.min(1, centre + spread),
  };
}

/**
 * Do these two rates differ by more than sampling noise?
 *
 * Non-overlapping Wilson intervals. Deliberately conservative: it is the test
 * that decides whether a difference is allowed to be called a finding, and the
 * cost of a false one here is a wrong PR against a stranger's repository.
 */
export function separated(before: Rate, after: Rate): boolean {
  return before.high < after.low || after.high < before.low;
}

/**
 * How many runs per intent, per side.
 *
 * Measured, not assumed — these are the actual separation points of the Wilson
 * test used above:
 *
 * | k | 0/k vs k/k | 0/k vs 80% |
 * |---|---|---|
 * | 3 | no | no |
 * | 4 | yes | no |
 * | 5 | yes | no |
 * | 8 | yes | **yes** |
 *
 * So the spec's k>=5 buys exactly one thing: a **complete** change of
 * behaviour. At k=5 even 0/5 against 4/5 does not separate. Catching a partial
 * shift — the model fills the field most of the time but not always — needs
 * k=8, and that is 60% more model spend for every intent.
 *
 * 5 is the default because the anchoring failure is a complete flip, and a
 * partial shift still gets reported, labelled `underpowered`. Raising k is a
 * knob, not a rewrite.
 */
export const MIN_RUNS = 5;

/** Runs per side needed before a partial shift can be called measured. */
export const RUNS_FOR_PARTIAL = 8;
