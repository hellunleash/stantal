import type { Constraints, Contract, Param, Tool } from "../contract/types.js";

/**
 * Putting a contract in front of a model and recording what it does.
 *
 * **Offline by default: nothing is executed.** The comparison is over the
 * model's *decisions* — which tool, which optional fields, what values — and a
 * decision needs no side effects and no credentials. That is what lets the
 * first `npx` run stay free of an account while still measuring the thing that
 * actually breaks.
 *
 * The interface is deliberately the same shape as `Judge`: an id, one method,
 * and no knowledge of caching or statistics. Those live outside it, so a
 * provider can be swapped without touching either.
 */

/** What the model did with one request. */
export type ToolChoice =
  | { kind: "tool_call"; tool: string; arguments: Record<string, unknown> }
  /** No tool was called. The text is kept because a clarifying question is a result. */
  | { kind: "no_call"; text: string };

/**
 * A turn that already happened, before the request being measured.
 *
 * This exists for one measured reason. A model fills an optional field with a
 * value it can only have got from earlier in the conversation — a name it was
 * just using, an id it was just handed. On a first turn there is nothing to
 * fill it with, so leaving the field out is the *correct* answer, and a
 * single-turn harness records the model getting it right and reports no
 * difference. The failure is invisible, not absent.
 *
 * A tool call and its result are **one** turn, not two. They always arrive as a
 * pair, and splitting them would let a corpus describe a call with no result —
 * which is not a state any conversation is in when the next user message
 * arrives.
 */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "call"; tool: string; arguments: Record<string, unknown>; result: string };

export type CallRequest = {
  /** The user's words, verbatim. Identical on both sides of a comparison. */
  intent: string;
  /** The contract as the model would receive it. */
  tools: WireTool[];
  /**
   * What was said before `intent`, oldest first. Absent for a first-turn request.
   *
   * Held identical across both sides of a comparison, exactly like `intent`,
   * and for the same reason: anything that differs between the sides is a
   * candidate explanation for the difference measured. That includes the case
   * where history names a tool the newer version renamed. Both sides then see
   * a conversation referring to the old name — which is what a real session
   * spanning an upgrade looks like — and because it is identical on both, it
   * cannot be what moved the result.
   *
   * Optional rather than defaulted to `[]` on purpose: `JSON.stringify` omits
   * an undefined property, so a first-turn request serializes byte-identically
   * to one recorded before this field existed. Every cassette already on disk
   * stays valid.
   */
  history?: Turn[];
};

/** A tool in the shape every provider's tool-calling API expects. */
export type WireTool = {
  name: string;
  description: string | null;
  inputSchema: JsonSchema;
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export interface ToolCaller {
  /** Provider and model, e.g. "openai:gpt-4o". Part of every cache key. */
  readonly id: string;
  call(request: CallRequest): Promise<ToolChoice>;
}

/**
 * The normalized contract, converted back to what goes on the wire.
 *
 * This is the inverse of `from-json-schema.ts`, and the fact that it is a clean
 * inverse is the practical argument for the contract being JSON-Schema-shaped:
 * a zod schema never reaches a model, so a contract modelled on zod would have
 * to be converted here anyway, in the harder direction.
 */
export function present(contract: Contract): WireTool[] {
  return contract.tools.map(presentTool);
}

export function presentTool(tool: Tool): WireTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of tool.params) {
    properties[param.name] = presentParam(param);
    if (param.required) required.push(param.name);
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;

  return { name: tool.name, description: tool.description, inputSchema: schema };
}

function presentParam(param: Param): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // `unknown` is our word for "we could not tell", and it is not a JSON Schema
  // type. Emitting it would make the schema invalid; omitting `type` says
  // "anything", which is the honest translation.
  if (param.type !== "unknown") out["type"] = param.type;
  if (param.description !== null) out["description"] = param.description;

  applyConstraints(out, param.constraints);

  if (param.children !== undefined && param.children.length > 0) {
    const nested: Record<string, unknown> = {};
    const required: string[] = [];
    for (const child of param.children) {
      nested[child.name] = presentParam(child);
      if (child.required) required.push(child.name);
    }
    const shape: Record<string, unknown> = { type: "object", properties: nested };
    if (required.length > 0) shape["required"] = required;

    if (param.type === "array") out["items"] = shape;
    else {
      out["properties"] = nested;
      if (required.length > 0) out["required"] = required;
    }
  }

  return out;
}

function applyConstraints(out: Record<string, unknown>, constraints: Constraints): void {
  const { minLength, maxLength, minimum, maximum, pattern, format } = constraints;
  if (minLength !== undefined) out["minLength"] = minLength;
  if (maxLength !== undefined) out["maxLength"] = maxLength;
  if (minimum !== undefined) out["minimum"] = minimum;
  if (maximum !== undefined) out["maximum"] = maximum;
  if (pattern !== undefined) out["pattern"] = pattern;
  if (format !== undefined) out["format"] = format;
  if (constraints.enum !== undefined && constraints.enum.length > 0) out["enum"] = constraints.enum;
  if (constraints.default !== undefined) out["default"] = constraints.default;
}

/**
 * A caller driven by a script instead of a model.
 *
 * Every test in this layer uses one. The rule from `how-to-move-fast.md` is that
 * a real model never appears in the loop used while thinking: it is slow, it is
 * priced, and it disagrees with itself, which makes a failing test unreadable.
 *
 * `answer` receives the request so a script can react to the contract it was
 * shown — which is the whole point. A script that ignores the tools it was given
 * cannot express "the model behaves differently on version B".
 */
export function scriptedCaller(
  id: string,
  answer: (request: CallRequest, run: number) => ToolChoice,
): ToolCaller & { calls: CallRequest[] } {
  const calls: CallRequest[] = [];
  let run = 0;
  return {
    id,
    calls,
    async call(request) {
      calls.push(request);
      return answer(request, run++);
    },
  };
}

/**
 * Does this call satisfy the contract it was made against?
 *
 * Checked against our own normalized contract, so no package code runs and no
 * validator is imported. Deliberately narrow — required fields, declared types,
 * enum membership, unknown keys. It is not a JSON Schema implementation and
 * must not grow into one: a false "invalid" is a fabricated finding.
 */
export function invalidArguments(tool: Tool, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const declared = new Map(tool.params.map((p) => [p.name, p]));

  for (const param of tool.params) {
    if (param.required && args[param.name] === undefined) {
      problems.push(`required \`${param.name}\` was not passed`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const param = declared.get(key);
    if (param === undefined) {
      problems.push(`\`${key}\` is not a declared parameter`);
      continue;
    }
    if (value === undefined || value === null) continue;

    if (param.type !== "unknown" && !matchesType(param.type, value)) {
      problems.push(`\`${key}\` should be ${param.type}`);
    }
    const allowed = param.constraints.enum;
    if (allowed !== undefined && allowed.length > 0 && !allowed.includes(value)) {
      problems.push(`\`${key}\` is not one of the declared values`);
    }
  }

  return problems;
}

function matchesType(type: Param["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
