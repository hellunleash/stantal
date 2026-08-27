import type { Param } from "../contract/types.js";

/**
 * Layer 5 — the test emitter.
 *
 * Every layer before this one ends in a sentence. A sentence is read once and
 * then it is gone: the report scrolls away, the pull request gets merged, and
 * six months later the same defect arrives again with nobody left who remembers
 * the first one.
 *
 * A test is the same finding in a form that outlives the person who ran the
 * tool. It sits in the consumer's repository, it runs on every build, and it
 * keeps failing until the contract it names is honoured again. Nothing about it
 * depends on us afterwards — that is the point, and it is why the spec ranks
 * this delivery above a patch: the recipient can check it without trusting us
 * at all.
 *
 * **The direction matters and is easy to get backwards.** An emitted test pins
 * what is true on the side the consumer depends on *now*, and fails when that
 * stops being true. A test asserting the broken state can never pass, so it
 * gets deleted in the first week. A test asserting the working state is a
 * tripwire the next upgrade has to walk through.
 */

export type AssertionKind =
  /** The tool is still offered under this name. */
  | "tool_present"
  /** The parameter is still accepted. */
  | "param_present"
  /** The parameter is still optional — callers may keep omitting it. */
  | "param_optional"
  /** The parameter is still required — its absence is still an error. */
  | "param_required"
  /** The parameter still takes this type. */
  | "param_type"
  /** The parameter's enum still admits these values. */
  | "enum_includes"
  /** The tool description still carries this sentence. */
  | "description_includes"
  /**
   * Something in the contract still explains when to pass this parameter.
   *
   * The only assertion here about meaning rather than shape, and the only one
   * that can be satisfied in more than one way — a sentence in the tool
   * description and a description on the parameter itself both count.
   */
  | "param_documented";

/** One checkable claim about a contract, and the reason it is worth pinning. */
export type Assertion = {
  kind: AssertionKind;
  /** The subpath this contract came from, so two doors never share a file. */
  subpath: string;
  tool: string;
  /** Set for every kind except `tool_present`. */
  param?: string;
  /** The value the assertion expects, for the kinds that carry one. */
  expected?: unknown;
  /**
   * Why this is pinned, in one line.
   *
   * Rendered as a comment above the test. A generated test with no reason in it
   * gets deleted the first time it fails, because nobody can tell whether it was
   * ever load-bearing.
   */
  why: string;
};

/**
 * Which findings have earned a test, per the spec's delivery ladder.
 *
 * `unconfirmed` means a rule matched a pattern and nothing checked the meaning.
 * That is a line in a report and never a file in someone's repository: a
 * generated test that is wrong costs more than the finding was worth, because
 * it is a failing build in a stranger's project with our name at the top of it.
 */
export const EARNS_A_TEST: ReadonlySet<string> = new Set(["certain", "likely"]);

/** Stable identity, so the same assertion is never written twice. */
export function assertionKey(a: Assertion): string {
  return `${a.subpath}|${a.kind}|${a.tool}${a.param === undefined ? "" : `.${a.param}`}`;
}

/**
 * Whether a parameter is documented anywhere a model would see it.
 *
 * Kept here rather than in the renderer because the emitter and the generated
 * test have to agree on it exactly. If the two drift, the test asserts
 * something the tool never claimed and fails for a reason nobody can trace.
 */
export function paramIsDocumented(toolDescription: string | null, param: Param): boolean {
  if (param.description !== null && param.description.trim().length > 0) return true;
  if (toolDescription === null) return false;
  return mentionsParam(toolDescription, param.name);
}

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Does this text refer to the parameter *as a parameter*?
 *
 * A bare word match does not work, and that is measured rather than assumed:
 * names like `app`, `limit` and `context` occur as ordinary English inside tool
 * descriptions that never explain the field at all. So a reference counts only
 * where the text marks it as one — a code span, a quoted name, a directive verb
 * attached to it, or a definition-list line that leads with it.
 */
export function mentionsParam(text: string, name: string): boolean {
  const escaped = name.replace(RE_SPECIAL, "\\$&");
  const tick = "`";
  const patterns = [
    new RegExp(tick + escaped + tick),
    new RegExp('["\'“‘]' + escaped + '["\'”’]'),
    new RegExp(
      "\\b(pass|passing|omit|omitting|set|setting|provide|providing|include|" +
        "including|supply|supplying|leave out|leaving out)\\s+" +
        tick +
        "?" +
        escaped +
        tick +
        "?\\b",
      "i",
    ),
    new RegExp("^\\s*[-*]\\s*" + tick + "?" + escaped + tick + "?\\s*[:—-]", "m"),
  ];
  return patterns.some((p) => p.test(text));
}
