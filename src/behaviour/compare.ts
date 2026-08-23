import type { Contract, Tool } from "../contract/types.js";
import { invalidArguments, type ToolChoice } from "./caller.js";
import type { Intent } from "./intent.js";
import {
  compareFindings,
  separated,
  severityOf,
  wilson,
  type BehaviourFinding,
  type BehaviourRule,
  type Rate,
} from "./taxonomy.js";

/**
 * Comparing what a model did on contract A against what it did on contract B.
 *
 * Everything here operates on *rates*, never on single runs. A model asked the
 * same question twice will not always answer the same way, so "it filled the
 * field this time and not last time" is noise until proven otherwise. Each rule
 * below computes a proportion for each side and fires only when the two
 * intervals do not overlap.
 *
 * The rules are deliberately about *decisions*, not outcomes. Whether the tool
 * call would have succeeded is a different question, needs credentials and side
 * effects, and is Layer 2's optional live mode. What breaks a consumer is that
 * the model started doing something else, and that is visible without running
 * anything.
 */

/** Every run of one intent against one side. */
export type IntentRuns = {
  intent: Intent;
  choices: ToolChoice[];
};

export type ComparisonInput = {
  before: { contract: Contract; runs: IntentRuns[] };
  after: { contract: Contract; runs: IntentRuns[] };
};

export type ComparisonResult = {
  findings: BehaviourFinding[];
  /** Intents that ran on only one side, so nothing about them can be compared. */
  skipped: Array<{ intentId: string; reason: string }>;
};

function calledTool(choice: ToolChoice): string | null {
  return choice.kind === "tool_call" ? choice.tool : null;
}

/** How often the runs chose this specific tool. */
function toolRate(choices: readonly ToolChoice[], tool: string): Rate {
  return wilson(choices.filter((c) => calledTool(c) === tool).length, choices.length);
}

/** How often any tool was called at all. */
function anyCallRate(choices: readonly ToolChoice[]): Rate {
  return wilson(choices.filter((c) => c.kind === "tool_call").length, choices.length);
}

/**
 * How often a field was filled, counted only over the runs that called the tool.
 *
 * Counting over all runs would confound two different changes: the model calling
 * a different tool, and the model filling a field differently. Those are
 * separate rules with separate severities, and mixing them would let one mask
 * the other.
 */
function fieldRate(choices: readonly ToolChoice[], tool: string, field: string): Rate {
  const relevant = choices.filter(
    (c): c is Extract<ToolChoice, { kind: "tool_call" }> => calledTool(c) === tool,
  );
  const filled = relevant.filter((c) => c.arguments[field] !== undefined).length;
  return wilson(filled, relevant.length);
}

function sampleArguments(choices: readonly ToolChoice[], tool: string): unknown {
  const found = choices.find((c) => calledTool(c) === tool);
  return found !== undefined && found.kind === "tool_call" ? found.arguments : null;
}

function sampleText(choices: readonly ToolChoice[]): unknown {
  const found = choices.find((c) => c.kind === "no_call");
  return found !== undefined && found.kind === "no_call" ? found.text : null;
}

/** How often the call it made failed the contract's own declared schema. */
function invalidRate(choices: readonly ToolChoice[], contract: Contract): Rate {
  const byName = new Map(contract.tools.map((t) => [t.name, t]));
  const calls = choices.filter(
    (c): c is Extract<ToolChoice, { kind: "tool_call" }> => c.kind === "tool_call",
  );
  const invalid = calls.filter((call) => {
    const tool = byName.get(call.tool);
    // A call to a tool the contract does not declare is its own problem, caught
    // by `tool_switched`. Counting it here too would double-report one event.
    return tool !== undefined && invalidArguments(tool, call.arguments).length > 0;
  }).length;
  return wilson(invalid, calls.length);
}

type Candidate = {
  rule: BehaviourRule;
  target: string;
  tool: string;
  before: Rate;
  after: Rate;
  headline: string;
};

/**
 * Which optional fields to ask about.
 *
 * Only fields optional on **both** sides. A field that changed required-ness is
 * a Layer 0 structural finding and already reported there; repeating it here as
 * a behaviour change would inflate every count downstream by describing one
 * event twice.
 */
function sharedOptionalFields(before: Tool | undefined, after: Tool | undefined): string[] {
  if (before === undefined || after === undefined) return [];
  const optionalAfter = new Set(after.params.filter((p) => !p.required).map((p) => p.name));
  return before.params
    .filter((p) => !p.required && optionalAfter.has(p.name))
    .map((p) => p.name);
}

function candidatesFor(
  intent: Intent,
  before: IntentRuns,
  after: IntentRuns,
  input: ComparisonInput,
): Candidate[] {
  const out: Candidate[] = [];

  // Did it stop calling anything, or start?
  const callBefore = anyCallRate(before.choices);
  const callAfter = anyCallRate(after.choices);
  if (callBefore.high < callAfter.low) {
    out.push({
      rule: "call_introduced",
      target: "(any)",
      tool: "(any)",
      before: callBefore,
      after: callAfter,
      headline: `the model now calls a tool for a request it used to answer without one`,
    });
  } else if (callAfter.high < callBefore.low) {
    out.push({
      rule: "call_abandoned",
      target: "(any)",
      tool: "(any)",
      before: callBefore,
      after: callAfter,
      headline: `the model stopped calling a tool for a request it used to serve`,
    });
  }

  const tools = new Set<string>();
  for (const choice of [...before.choices, ...after.choices]) {
    const name = calledTool(choice);
    if (name !== null) tools.add(name);
  }

  const beforeTools = new Map(input.before.contract.tools.map((t) => [t.name, t]));
  const afterTools = new Map(input.after.contract.tools.map((t) => [t.name, t]));

  for (const tool of [...tools].sort()) {
    const rateBefore = toolRate(before.choices, tool);
    const rateAfter = toolRate(after.choices, tool);

    if (separated(rateBefore, rateAfter)) {
      const direction = rateAfter.low > rateBefore.high ? "now" : "no longer";
      out.push({
        rule: "tool_switched",
        target: tool,
        tool,
        before: rateBefore,
        after: rateAfter,
        headline: `the model ${direction} picks \`${tool}\` for this request`,
      });
      // Field-level questions about a tool it stopped choosing are not
      // meaningful, and the sample on one side would be empty anyway.
      continue;
    }

    for (const field of sharedOptionalFields(beforeTools.get(tool), afterTools.get(tool))) {
      const fieldBefore = fieldRate(before.choices, tool, field);
      const fieldAfter = fieldRate(after.choices, tool, field);
      if (!separated(fieldBefore, fieldAfter)) continue;

      const appeared = fieldAfter.low > fieldBefore.high;
      out.push({
        rule: appeared ? "optional_field_appeared" : "optional_field_dropped",
        target: `${tool}.${field}`,
        tool,
        before: fieldBefore,
        after: fieldAfter,
        headline: appeared
          ? `the model now fills \`${field}\`, which it used to leave out`
          : `the model stopped filling \`${field}\`, which it used to pass`,
      });
    }
  }

  const invalidBefore = invalidRate(before.choices, input.before.contract);
  const invalidAfter = invalidRate(after.choices, input.after.contract);
  if (invalidAfter.low > invalidBefore.high) {
    out.push({
      rule: "arguments_invalid",
      target: "(any)",
      tool: "(any)",
      before: invalidBefore,
      after: invalidAfter,
      headline: `the arguments the model builds no longer satisfy the declared schema`,
    });
  }

  return out;
}

export function compareRuns(input: ComparisonInput): ComparisonResult {
  const beforeByIntent = new Map(input.before.runs.map((r) => [r.intent.id, r]));
  const afterByIntent = new Map(input.after.runs.map((r) => [r.intent.id, r]));

  const findings: BehaviourFinding[] = [];
  const skipped: ComparisonResult["skipped"] = [];

  for (const [id, before] of beforeByIntent) {
    const after = afterByIntent.get(id);
    if (after === undefined) {
      skipped.push({ intentId: id, reason: "the intent did not run against the newer version" });
      continue;
    }
    if (before.choices.length === 0 || after.choices.length === 0) {
      skipped.push({ intentId: id, reason: "one side produced no runs" });
      continue;
    }

    for (const candidate of candidatesFor(before.intent, before, after, input)) {
      // Both sides must have run the same number of times before a difference
      // can be called measured. Unequal k is not a comparison, it is two
      // samples of different strength wearing one label.
      const balanced = before.choices.length === after.choices.length;

      findings.push({
        rule: candidate.rule,
        target: candidate.target,
        tool: candidate.tool,
        severity: severityOf(candidate.rule),
        basis: balanced ? "measured" : "underpowered",
        headline: candidate.headline,
        evidence: {
          intent: before.intent.text,
          intentId: id,
          before: candidate.before,
          after: candidate.after,
          beforeSample:
            candidate.tool === "(any)"
              ? sampleText(before.choices)
              : sampleArguments(before.choices, candidate.tool),
          afterSample:
            candidate.tool === "(any)"
              ? sampleText(after.choices)
              : sampleArguments(after.choices, candidate.tool),
        },
      });
    }
  }

  for (const id of afterByIntent.keys()) {
    if (!beforeByIntent.has(id)) {
      skipped.push({ intentId: id, reason: "the intent did not run against the older version" });
    }
  }

  return { findings: findings.sort(compareFindings), skipped };
}
