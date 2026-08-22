import { parse } from "acorn";
import type { AnyNode, ExpressionStatement, Program } from "acorn";
import { describe, expect, test } from "vitest";
import { UNRESOLVED, evaluate, isUnresolved } from "./js-literal.js";

/** Parse one expression so the evaluator can be exercised directly. */
function expression(code: string): AnyNode {
  const program: Program = parse(`(${code})`, { ecmaVersion: "latest", sourceType: "module" });
  const first = program.body[0] as ExpressionStatement;
  return first.expression as AnyNode;
}

function fold(code: string, bindings: Record<string, unknown> = {}) {
  return evaluate(expression(code), (name) => (name in bindings ? bindings[name] : UNRESOLVED));
}

describe("evaluate", () => {
  test("folds the literal shapes a tool schema is made of", () => {
    const { value } = fold(`{
      type: "object",
      properties: { request: { type: "string", minLength: 1 } },
      required: ["request"],
      additionalProperties: false,
    }`);
    expect(value).toEqual({
      type: "object",
      properties: { request: { type: "string", minLength: 1 } },
      required: ["request"],
      additionalProperties: false,
    });
  });

  test("resolves a name pulled from a constant", () => {
    const { value } = fold(`{ name: TOOL_NAME }`, { TOOL_NAME: "build" });
    expect(value).toEqual({ name: "build" });
  });

  test("folds descriptions assembled from templates and concatenation", () => {
    expect(fold("`Build a ${THING}.`", { THING: "screen" }).value).toBe("Build a screen.");
    expect(fold(`"Pass " + FIELD + " only when asked."`, { FIELD: "`slot`" }).value).toBe(
      "Pass `slot` only when asked.",
    );
  });

  test("reads a schema shared through a constant object", () => {
    const { value } = fold(`SCHEMAS.create`, { SCHEMAS: { create: { type: "object" } } });
    expect(value).toEqual({ type: "object" });
  });

  test("merges a spread it can read", () => {
    const { value } = fold(`{ ...BASE, minLength: 1 }`, { BASE: { type: "string" } });
    expect(value).toEqual({ type: "string", minLength: 1 });
  });

  test("never calls a function", () => {
    const { value, unresolved } = fold(`buildSchema()`);
    expect(isUnresolved(value)).toBe(true);
    expect(unresolved).toEqual(["<root>"]);
  });

  test("drops an unreadable value but names the path it dropped", () => {
    const { value, unresolved } = fold(`{ name: "build", description: getText() }`);
    expect(value).toEqual({ name: "build" });
    // The path is the whole point: an absent key here is our gap, and a caller
    // that cannot tell the difference would report the package as shipping no
    // guidance when it ships plenty.
    expect(unresolved).toEqual(["description"]);
  });

  test("refuses a partial array, because a partial `required` is a different contract", () => {
    const { value, unresolved } = fold(`{ required: ["a", computed()] }`);
    expect(value).toEqual({});
    expect(unresolved).toContain("required");
  });

  test("refuses the whole object when a spread cannot be read", () => {
    const { value } = fold(`{ ...unknownBase(), type: "string" }`);
    // Reporting only `type` would describe a narrower schema than ships.
    expect(isUnresolved(value)).toBe(true);
  });

  test("does not take a branch", () => {
    expect(isUnresolved(fold(`flag ? "a" : "b"`, { flag: true }).value)).toBe(true);
  });

  test("survives a self-referential constant instead of hanging", () => {
    // The resolver a real module builds is recursive; a cycle must terminate.
    const seen = { A: UNRESOLVED };
    expect(isUnresolved(fold(`A`, seen).value)).toBe(true);
  });
});
