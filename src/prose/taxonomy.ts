/**
 * Layer 1 — the prose taxonomy.
 *
 * Descriptions are contract, because for a model they *are* the contract. This
 * is the fixed vocabulary those changes get classified into. It is closed on
 * purpose: a free-text summary of what changed is not a product, because nothing
 * downstream can branch on it and no two runs agree.
 *
 * Every rule here answers one question, has one severity, and is only allowed to
 * fire with the exact text it rests on attached.
 */

export type ProseRule =
  /** A clause explaining when or whether to pass a field was deleted. */
  | "guidance_removed"
  /** "Pass X only when…" semantics were altered. */
  | "mode_switch_changed"
  /** A worked example a model was relying on is gone. */
  | "example_removed"
  /** A worked example appeared. */
  | "example_added"
  /** An optional parameter is offered with no guidance anywhere in the contract. */
  | "undocumented_optional"
  /** The field's name implies the opposite of what it does. */
  | "name_semantics_inverted"
  /** Two doors of the same version describe the same tool differently. */
  | "surface_divergence";

export type Severity = "high" | "medium" | "low";

/**
 * How a finding was reached.
 *
 * `deterministic` — derived from the text by a rule; reproducible, free, and
 * exactly as smart as the rule.
 * `judged` — a model answered a closed question about the text, and its quote
 * was checked against the source.
 */
export type Basis = "deterministic" | "judged";

/**
 * How much the finding is worth acting on.
 *
 * `unconfirmed` is the important one. It means a deterministic rule matched a
 * pattern that usually indicates the problem, but nothing has checked the
 * meaning. It is a lead, not a verdict, and it must be labelled that way
 * wherever it is shown.
 */
export type Confidence = "certain" | "likely" | "unconfirmed";

/** The exact text a claim rests on, so a reader can check it. */
export type ProseEvidence = {
  /** Where in the contract: `tool` or `tool.param`. */
  target: string;
  /** The text as shipped at the older version, when there is one. */
  before: string | null;
  /** The text as shipped at the newer version. */
  after: string | null;
  /** The specific span that triggered the rule, quoted verbatim from the above. */
  quote: string | null;
  /** Source location from extraction, when the extractor recorded one. */
  location: string | null;
};

export type ProseFinding = {
  rule: ProseRule;
  /** `tool` or `tool.param`. */
  target: string;
  tool: string;
  severity: Severity;
  basis: Basis;
  confidence: Confidence;
  /** One line a human can read and act on. Never a paragraph. */
  headline: string;
  evidence: ProseEvidence;
};

/**
 * Default severity per rule.
 *
 * `undocumented_optional` sits at medium on its own and is raised to high when a
 * judge confirms the name reads backwards, because those two together are what
 * make a parameter actively misleading rather than merely bare.
 */
const SEVERITY: Record<ProseRule, Severity> = {
  guidance_removed: "high",
  mode_switch_changed: "high",
  name_semantics_inverted: "high",
  surface_divergence: "high",
  undocumented_optional: "medium",
  example_removed: "medium",
  example_added: "low",
};

export function severityOf(rule: ProseRule): Severity {
  return SEVERITY[rule];
}

/** Sort order for display: worst first, then by rule, then by target. */
export function compareFindings(a: ProseFinding, b: ProseFinding): number {
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  const confidenceRank: Record<Confidence, number> = { certain: 0, likely: 1, unconfirmed: 2 };
  return (
    rank[a.severity] - rank[b.severity] ||
    confidenceRank[a.confidence] - confidenceRank[b.confidence] ||
    a.rule.localeCompare(b.rule) ||
    a.target.localeCompare(b.target)
  );
}
