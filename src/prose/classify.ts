import type { ExtractionNote, SurfaceResult } from "../contract/surface.js";
import type { Contract, Tool } from "../contract/types.js";
import { noJudge, reconcile, type Judge, type JudgeQuestion } from "./judge.js";
import {
  compareFindings,
  severityOf,
  type ProseFinding,
  type ProseRule,
} from "./taxonomy.js";
import {
  addedSentences,
  looksLikeExample,
  looksLikeModeSwitch,
  mentionsParameter,
  deletedSentences,
} from "./text.js";

/**
 * Layer 1 — classifying what changed in the prose.
 *
 * The order is deliberate and is the cost lever for the whole layer:
 *
 *   deterministic candidates  ->  judge (only where meaning is in question)  ->  findings
 *
 * Text facts are settled by rules. A sentence that was there and is gone is not
 * a matter of opinion, and paying a model to confirm it would be waste. What the
 * rules cannot settle is meaning: whether prose that never names a parameter
 * still explains it, and whether a name reads backwards. Those go to the judge,
 * one closed question at a time.
 *
 * A finding that reaches neither — pattern matched, meaning unchecked — is
 * reported as `unconfirmed`. It is a lead. Saying so is the difference between
 * this and a linter that cries wolf.
 */

export type ProseResult = {
  findings: ProseFinding[];
  /**
   * Targets that were skipped because extraction could not read their text.
   * Never silently dropped: a gap in the reading must not look like a clean bill.
   */
  skipped: Array<{ target: string; reason: string }>;
  /** Which judge answered, so a cached result can be invalidated by a better one. */
  judge: string;
};

type Candidate = {
  rule: ProseRule;
  tool: string;
  target: string;
  before: string | null;
  after: string | null;
  quote: string | null;
  headline: string;
  /** Set when the finding is only a lead until a judge confirms it. */
  question?: JudgeQuestion;
};

function toolsOf(result: SurfaceResult): Map<string, Tool> {
  return result.present ? new Map(result.contract.tools.map((t) => [t.name, t])) : new Map();
}

function contractOf(result: SurfaceResult): Contract | null {
  return result.present ? result.contract : null;
}

/**
 * Targets extraction could not read, which this layer must not talk about.
 *
 * If a description came back null because the extractor could not fold it, every
 * prose rule would fire on it — reporting our own blind spot as the package
 * shipping nothing.
 */
type Blocked = {
  /** Tools whose prose could not be read. Nothing about their text is safe. */
  descriptions: Map<string, string>;
  /**
   * Paths whose schema could not be read, keyed by `tool` or `tool.param`.
   *
   * Keyed by path rather than by tool because the reader now reports gaps at
   * the precision it actually has. A tool whose `options` field is built by a
   * shape-changing call still has a perfectly readable `url` next to it, and
   * blocking the whole tool for that would throw away the readable half.
   */
  parameters: Map<string, string>;
};

/**
 * What extraction could not read, split by what it actually blocks.
 *
 * The split matters and an earlier version got it wrong by collapsing the two.
 * A tool whose schema is built at runtime — zod, a builder, a generated map —
 * still ships a perfectly readable description, and blocking prose analysis for
 * it threw away the majority of real findings across every history measured.
 *
 * A schema gap blocks claims about parameters. A description gap blocks claims
 * about text. Neither blocks the other.
 */
function unreadable(results: readonly SurfaceResult[]): Blocked {
  const blocked: Blocked = { descriptions: new Map(), parameters: new Map() };

  for (const result of results) {
    if (!result.present) continue;
    for (const note of result.notes as ExtractionNote[]) {
      if (note.scope === "surface") continue; // a tool-set gap, handled by Layer 0
      if (note.target === null) continue;
      const reason = `${note.code} at ${note.evidence ?? "unknown location"}`;

      if (note.scope === "description") {
        // Prose is read per tool, so a gap in it is a gap for the whole tool.
        blocked.descriptions.set(note.target.split(".")[0] ?? note.target, reason);
        continue;
      }

      // Schema gaps keep their full path. A bare tool name means the parameter
      // set itself is unknown; anything longer names one branch of it.
      blocked.parameters.set(note.target, reason);
    }
  }

  return blocked;
}

/** Whether a candidate names a parameter, which decides which gap can block it. */
function isParameterClaim(candidate: Candidate): boolean {
  return candidate.target.includes(".");
}

/**
 * The recorded gap that covers this target, if any.
 *
 * A gap covers a target when it names the target or an ancestor of it: a gap on
 * `crawl` covers `crawl.url`, and a gap on `crawl.options` covers
 * `crawl.options.timeout` — but neither covers `crawl.limit`.
 */
function gapCovering(blocked: Map<string, string>, target: string): string | undefined {
  const parts = target.split(".");
  for (let end = parts.length; end > 0; end -= 1) {
    const reason = blocked.get(parts.slice(0, end).join("."));
    if (reason !== undefined) return reason;
  }
  return undefined;
}

// --- Rules over a single contract -------------------------------------------

/**
 * An optional parameter offered with no guidance anywhere.
 *
 * Fires when the parameter has no description of its own AND the tool
 * description never refers to it as a parameter. The second half is what makes
 * it usable: a field whose purpose is explained in the tool's prose is
 * documented, even with a null description, and reporting it would be noise.
 *
 * Marked unconfirmed on its own. A rule can see that no sentence names the
 * parameter; it cannot see whether some sentence explains it without naming it.
 */
function undocumentedOptional(tool: Tool): Candidate[] {
  const description = tool.description ?? "";
  const siblings = tool.params.map((p) => p.name);

  return tool.params
    .filter((param) => !param.required && param.description === null)
    .filter((param) => mentionsParameter(description, param.name) === null)
    .map((param) => ({
      rule: "undocumented_optional" as const,
      tool: tool.name,
      target: `${tool.name}.${param.name}`,
      before: null,
      after: description.length > 0 ? description : null,
      quote: null,
      headline: `\`${param.name}\` is optional, has no description, and the tool description never says when to pass it`,
      question: {
        id: `documented:${tool.name}.${param.name}`,
        kind: "is_parameter_documented" as const,
        tool: tool.name,
        param: param.name,
        description,
      },
    }));
}

// --- Rules over a version pair ----------------------------------------------

/** Below this, a deleted sentence is an edit rather than a loss of guidance. */
const MIN_GUIDANCE_LENGTH = 40;

/**
 * Guidance that was shipped and is gone.
 *
 * Most deleted prose is about the tool, not about a named parameter — "use this
 * when...", "returns...", "do not call this if...". An earlier version of this
 * rule only fired when a removed sentence named a surviving parameter, and
 * measured against real release histories it caught almost nothing: tool
 * descriptions collapsing from 224 characters to 65 went unreported, which is
 * precisely the change this product exists to catch.
 *
 * So the target is the tool by default, and narrows to a parameter only when the
 * removed sentence actually refers to one.
 *
 * At most one finding per target. A rewrite that drops six sentences is one
 * event, and reporting it six times would inflate every count downstream.
 */
function guidanceRemoved(before: Tool, after: Tool): Candidate[] {
  if (before.description === null || after.description === null) return [];
  const surviving = new Set(after.params.map((p) => p.name));

  type Strongest = { rule: ProseRule; quote: string; param: string | null; count: number };
  const strongest = new Map<string, Strongest>();

  for (const sentence of deletedSentences(before.description, after.description)) {
    if (sentence.length < MIN_GUIDANCE_LENGTH) continue;

    const param = [...surviving].find((name) => mentionsParameter(sentence, name) !== null) ?? null;
    const target = param === null ? after.name : `${after.name}.${param}`;

    // Losing "pass X only when..." does not just remove guidance; it removes the
    // thing that told a model which of two behaviours it was asking for.
    const rule: ProseRule = looksLikeModeSwitch(sentence)
      ? "mode_switch_changed"
      : looksLikeExample(sentence)
        ? "example_removed"
        : "guidance_removed";

    const existing = strongest.get(target);
    if (existing === undefined) {
      strongest.set(target, { rule, quote: sentence, param, count: 1 });
      continue;
    }

    existing.count += 1;
    // A mode switch outranks plain guidance, and a longer quote is better
    // evidence than a shorter one.
    const outranks = rule === "mode_switch_changed" && existing.rule !== "mode_switch_changed";
    if (outranks || (rule === existing.rule && sentence.length > existing.quote.length)) {
      existing.rule = rule;
      existing.quote = sentence;
    }
  }

  return [...strongest.entries()].map(([target, entry]) => {
    const more = entry.count > 1 ? ` (and ${entry.count - 1} more sentence(s))` : "";
    const subject = entry.param === null ? `\`${after.name}\`` : `\`${entry.param}\``;
    const headline =
      entry.rule === "mode_switch_changed"
        ? `the sentence setting when to pass ${subject} was removed${more}`
        : entry.rule === "example_removed"
          ? `a worked example was removed from ${subject}${more}`
          : `guidance for ${subject} was removed from the description${more}`;

    return {
      rule: entry.rule,
      tool: after.name,
      target,
      before: before.description,
      after: after.description,
      quote: entry.quote,
      headline,
    };
  });
}

/**
 * A worked example that appeared.
 *
 * Removals are handled by `guidanceRemoved`, which already classifies a deleted
 * example as one. Only additions are left here, and they are the one thing in
 * the taxonomy that is usually good news.
 */
function exampleAdded(before: Tool, after: Tool): Candidate[] {
  if (before.description === null || after.description === null) return [];

  return addedSentences(before.description, after.description)
    .filter(looksLikeExample)
    .slice(0, 1)
    .map((sentence) => ({
      rule: "example_added" as const,
      tool: after.name,
      target: after.name,
      before: before.description,
      after: after.description,
      quote: sentence,
      headline: `a worked example was added to \`${after.name}\``,
    }));
}

// --- Orchestration ----------------------------------------------------------

function candidatesFor(from: SurfaceResult | null, to: SurfaceResult): Candidate[] {
  const target = contractOf(to);
  if (target === null) return [];

  const out: Candidate[] = [];
  const before = from === null ? new Map<string, Tool>() : toolsOf(from);

  for (const tool of target.tools) {
    out.push(...undocumentedOptional(tool));

    const earlier = before.get(tool.name);
    if (earlier === undefined) continue;
    out.push(...guidanceRemoved(earlier, tool));
    out.push(...exampleAdded(earlier, tool));
  }

  return out;
}

/**
 * Ask the judge about a candidate, and let the answer set the finding's weight.
 *
 * The judge can only move a finding down or leave it. It cannot invent one, and
 * a `yes` on "is this documented" retires the candidate entirely — which is the
 * point: the cheapest thing a judge can do here is stop a false report.
 */
function applyAnswer(
  candidate: Candidate,
  answers: Map<string, { verdict: string; quote: string | null }>,
): ProseFinding | null {
  const base = {
    rule: candidate.rule,
    target: candidate.target,
    tool: candidate.tool,
    severity: severityOf(candidate.rule),
    headline: candidate.headline,
    evidence: {
      target: candidate.target,
      before: candidate.before,
      after: candidate.after,
      quote: candidate.quote,
      location: null,
    },
  };

  if (candidate.question === undefined) {
    // A text fact. The sentence was there and is not any more.
    return { ...base, basis: "deterministic", confidence: "certain" };
  }

  const answer = answers.get(candidate.question.id);
  if (answer === undefined || answer.verdict === "unclear") {
    return { ...base, basis: "deterministic", confidence: "unconfirmed" };
  }

  if (answer.verdict === "yes") {
    // The description does explain it, in words the rule could not see. This
    // candidate was a false positive and is dropped rather than reported weakly.
    return null;
  }

  return {
    ...base,
    basis: "judged",
    confidence: "likely",
    evidence: { ...base.evidence, quote: answer.quote ?? base.evidence.quote },
  };
}

export async function classifyProse(
  from: SurfaceResult | null,
  to: SurfaceResult,
  judge: Judge = noJudge,
): Promise<ProseResult> {
  const blocked = unreadable(from === null ? [to] : [from, to]);
  const all = candidatesFor(from, to);

  const skipped: ProseResult["skipped"] = [];
  const usable: Candidate[] = [];
  for (const candidate of all) {
    // A gap only blocks the kind of claim it actually covers.
    const reason = isParameterClaim(candidate)
      ? (gapCovering(blocked.parameters, candidate.target) ??
        blocked.descriptions.get(candidate.tool))
      : blocked.descriptions.get(candidate.tool);
    if (reason === undefined) usable.push(candidate);
    else skipped.push({ target: candidate.target, reason });
  }

  const questions = usable
    .map((c) => c.question)
    .filter((q): q is JudgeQuestion => q !== undefined);

  const answers =
    questions.length === 0 ? new Map() : reconcile(questions, await judge.ask(questions));

  const findings = usable
    .map((candidate) => applyAnswer(candidate, answers))
    .filter((f): f is ProseFinding => f !== null)
    .sort(compareFindings);

  return { findings, skipped, judge: judge.id };
}
