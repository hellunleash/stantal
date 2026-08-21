import { describe, expect, test } from "vitest";
import { paramsFromInputSchema, toolFrom } from "./from-json-schema.js";

/**
 * A tool with a mix of documented and undocumented parameters, one required.
 * Normalization must record the absent descriptions as `null` rather than
 * smoothing them away.
 */
const BUILD_INPUT_SCHEMA = {
  type: "object",
  properties: {
    request: { type: "string", minLength: 1, description: "What to build." },
    context: { type: "string" },
    target: { type: "string", minLength: 1 },
    slot: { type: "string" },
  },
  required: ["request"],
};

describe("paramsFromInputSchema", () => {
  test("records an absent parameter description as null", () => {
    const params = paramsFromInputSchema(BUILD_INPUT_SCHEMA);
    const target = params.find((p) => p.name === "target");

    expect(target).toBeDefined();
    expect(target?.description).toBeNull();
    expect(target?.required).toBe(false);
    expect(target?.type).toBe("string");
    expect(target?.constraints.minLength).toBe(1);
  });

  test("keeps a real description intact", () => {
    const params = paramsFromInputSchema(BUILD_INPUT_SCHEMA);
    expect(params.find((p) => p.name === "request")?.description).toBe("What to build.");
  });

  test("marks required and optional correctly", () => {
    const params = paramsFromInputSchema(BUILD_INPUT_SCHEMA);
    const required = params.filter((p) => p.required).map((p) => p.name);
    expect(required).toEqual(["request"]);
  });

  test("an empty-string description is the same absence as no description", () => {
    const params = paramsFromInputSchema({
      type: "object",
      properties: { a: { type: "string", description: "   " }, b: { type: "string" } },
    });
    expect(params.find((p) => p.name === "a")?.description).toBeNull();
    expect(params.find((p) => p.name === "b")?.description).toBeNull();
  });

  test("descends into nested object properties", () => {
    const params = paramsFromInputSchema({
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: { id: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } },
          required: ["id"],
        },
      },
    });
    const children = params[0]?.children ?? [];
    expect(children.map((c) => c.name)).toEqual(["id", "mode"]);
    expect(children.find((c) => c.name === "id")?.required).toBe(true);
    expect(children.find((c) => c.name === "mode")?.constraints.enum).toEqual(["a", "b"]);
  });

  test("survives a schema with no properties", () => {
    expect(paramsFromInputSchema({ type: "object" })).toEqual([]);
    expect(paramsFromInputSchema(undefined)).toEqual([]);
    expect(paramsFromInputSchema("not a schema")).toEqual([]);
  });
});

describe("toolFrom", () => {
  test("builds a normalized tool", () => {
    const tool = toolFrom("build", "Build a screen.", BUILD_INPUT_SCHEMA);
    expect(tool.name).toBe("build");
    expect(tool.description).toBe("Build a screen.");
    expect(tool.params.map((p) => p.name)).toEqual(["request", "context", "target", "slot"]);
  });

  test("records a tool shipped with no description as null", () => {
    expect(toolFrom("t", undefined, {}).description).toBeNull();
  });
});
