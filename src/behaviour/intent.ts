import { createHash } from "node:crypto";
import type { Contract, Tool } from "../contract/types.js";
import type { Turn } from "./caller.js";

/**
 * What a user asked for, held still while the contract moves under it.
 *
 * **The intent must never be derived from the contract under test.** That is the
 * one property this whole layer rests on, and getting it wrong makes the
 * measurement circular: generate the request from version B's prose and the
 * model will of course do well on version B, because the request was written to
 * match it. The finding would be an artefact of the harness.
 *
 * So an intent is keyed to a *tool*, not to a version. "Make me a screen listing
 * my roles" is what the user wants whether the vendor reworded the description
 * last Tuesday or not. Two consequences fall out, both good:
 *
 * 1. The comparison is honest — the same words go to both sides.
 * 2. A walk over 40 releases reuses one corpus, so intent generation is paid for
 *    once per package rather than once per version pair.
 */

export type Intent = {
  id: string;
  /** The user's request, verbatim. This is what goes to the model. */
  text: string;
  /**
   * The conversation `text` continues, oldest first. Absent for a first turn.
   *
   * Part of the intent, so it is held still across both sides exactly like the
   * text is. A corpus without this can only ever observe first-turn failures,
   * which is a bound on what a clean Layer 2 run is allowed to mean.
   */
  history?: Turn[];
  /**
   * Tools this request could plausibly reach.
   *
   * Drives affected-intent selection: a version pair only replays the intents
   * whose slice actually changed. On a typical minor bump that is most of the
   * saving in the layer.
   */
  slice: string[];
  /**
   * True when the correct behaviour is to call nothing.
   *
   * The false-positive control. Without it a contract that made the model
   * call tools more eagerly would look like an improvement on every metric.
   */
  expectsNoCall: boolean;
};

/**
 * Stable identity of an intent, so a cache key survives a reordering.
 *
 * History is part of it. Two intents ending in the same sentence after
 * different conversations are different questions, and giving them one id
 * would let an answer recorded for one be served for the other.
 */
export function intentHash(intent: Intent): string {
  const body =
    intent.history === undefined || intent.history.length === 0
      ? intent.text
      : JSON.stringify({ history: intent.history, text: intent.text });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * Which tools changed between two contracts, by name.
 *
 * Deliberately coarse. It answers "is this tool worth re-running", not "what
 * changed" — Layers 0 and 1 already answer that, and a slice test that tried to
 * be precise would start making claims it cannot support.
 */
export function changedTools(before: Contract | null, after: Contract): Set<string> {
  const changed = new Set<string>();
  if (before === null) {
    for (const tool of after.tools) changed.add(tool.name);
    return changed;
  }

  const previous = new Map(before.tools.map((t) => [t.name, t]));

  for (const tool of after.tools) {
    const earlier = previous.get(tool.name);
    if (earlier === undefined || !sameTool(earlier, tool)) changed.add(tool.name);
  }
  // A removed tool changes behaviour for every intent that used to reach it.
  for (const name of previous.keys()) if (!after.tools.some((t) => t.name === name)) changed.add(name);

  return changed;
}

function sameTool(before: Tool, after: Tool): boolean {
  if (before.description !== after.description) return false;
  if (before.params.length !== after.params.length) return false;

  const previous = new Map(before.params.map((p) => [p.name, p]));
  return after.params.every((param) => {
    const earlier = previous.get(param.name);
    return (
      earlier !== undefined &&
      earlier.required === param.required &&
      earlier.type === param.type &&
      earlier.description === param.description
    );
  });
}

export type SelectionMode =
  /** Replay only the intents whose slice changed. */
  | "affected"
  /** Replay everything. */
  | "full";

/**
 * Which intents to replay for a version pair.
 *
 * The safety rule is the spec's, and it is not an optimisation detail: a change
 * in one tool can change which tool the model picks, and slice tagging cannot
 * see that. So trimming is allowed on patch and minor bumps and never on a
 * major one.
 *
 * An intent with an empty slice always runs. An untagged intent is not a
 * cheap intent, it is an unknown one, and skipping unknowns is how a selection
 * optimisation turns into a missed finding.
 */
export function selectIntents(
  intents: readonly Intent[],
  changed: ReadonlySet<string>,
  mode: SelectionMode,
): Intent[] {
  if (mode === "full") return [...intents];

  return intents.filter((intent) => {
    if (intent.slice.length === 0) return true;
    // A no-call control is about the whole surface, so any change can flip it.
    if (intent.expectsNoCall) return true;
    return intent.slice.some((tool) => changed.has(tool));
  });
}

/**
 * A breaking bump forces a full replay; anything else may be trimmed.
 *
 * **Under `0.x` the minor is the major.** npm already works this way — `^0.7.0`
 * does not match `0.24.0` — and getting it wrong here would trim the corpus on
 * exactly the bumps most likely to move behaviour. The anchoring case is
 * 0.7.0 -> 0.24.0, which a naive major-only reading calls a minor bump.
 */
export function breakingBump(from: string, to: string): boolean {
  const parts = (version: string): number[] =>
    version.split("-")[0]?.split(".").map((n) => Number.parseInt(n, 10) || 0) ?? [0];

  const a = parts(from);
  const b = parts(to);
  const [majorA = 0, minorA = 0] = a;
  const [majorB = 0, minorB = 0] = b;

  if (majorA !== majorB) return true;
  return majorA === 0 && minorA !== minorB;
}

export function modeForBump(from: string, to: string): SelectionMode {
  return breakingBump(from, to) ? "full" : "affected";
}
