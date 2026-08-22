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
  removedSentences,
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
function unreadable(results: readonly SurfaceResult[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const result of results) {
    if (!result.present) continue;
    for (const note of result.notes as ExtractionNote[]) {
      if (note.scope === "surface") continue; // a tool-set gap, handled by Layer 0
      if (note.target === null) continue;
      const tool = note.target.split(".")[0] ?? note.target;
      out.set(tool, `${note.code} at ${note.evidence ?? "unknown location"}`);
    }
  }
  return out;
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

/** Sentences that referred to a parameter and are gone, where the parameter remains. */
function guidanceRemoved(before: Tool, after: Tool): Candidate[] {
  if (before.description === null || after.description === null) return [];
  const surviving = new Set(after.params.map((p) => p.name));
  const out: Candidate[] = [];

  for (const sentence of removedSentences(before.description, after.description)) {
    for (const name of surviving) {
      const mention = mentionsParameter(sentence, name);
      if (mention === null) continue;

      // A mode-switch sentence is its own rule: losing "pass X only when…" does
      // not just remove guidance, it removes the thing that told a model which
      // of two behaviours it was asking for.
      const rule: ProseRule = looksLikeModeSwitch(sentence) ? "mode_switch_changed" : "guidance_removed";
      out.push({
        rule,
        tool: after.name,
        target: `${after.name}.${name}`,
        before: before.description,
        after: after.description,
        quote: sentence,
        headline:
          rule === "mode_switch_changed"
            ? `the sentence setting when to pass \`${name}\` was removed`
            : `guidance for \`${name}\` was removed from the description`,
      });
      break; // one finding per removed sentence
    }
  }

  return out;
}

function exampleDelta(before: Tool, after: Tool): Candidate[] {
  if (before.description === null || after.description === null) return [];
  const out: Candidate[] = [];

  for (const sentence of removedSentences(before.description, after.description)) {
    if (!looksLikeExample(sentence)) continue;
    out.push({
      rule: "example_removed",
      tool: after.name,
      target: after.name,
      before: before.description,
      after: after.description,
      quote: sentence,
      headline: `a worked example was removed from \`${after.name}\``,
    });
  }

  for (const sentence of addedSentences(before.description, after.description)) {
    if (!looksLikeExample(sentence)) continue;
    out.push({
      rule: "example_added",
      tool: after.name,
      target: after.name,
      before: before.description,
      after: after.description,
      quote: sentence,
      headline: `a worked example was added to \`${after.name}\``,
    });
  }

  return out;
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
    out.push(...exampleDelta(earlier, tool));
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
    const reason = blocked.get(candidate.tool);
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
