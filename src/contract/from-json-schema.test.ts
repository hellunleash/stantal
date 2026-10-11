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

describe("array elements", () => {
  test("reads the element of an array of scalars", () => {
    const [xs] = paramsFromInputSchema({
      type: "object",
      properties: { xs: { type: "array", items: { type: "string", minLength: 1 } } },
    });
    expect(xs?.type).toBe("array");
    expect(xs?.items?.name).toBe("[]");
    expect(xs?.items?.type).toBe("string");
    expect(xs?.items?.constraints.minLength).toBe(1);
    // `children` holds an object element's properties. Both set would be two
    // representations of one fact.
    expect(xs?.children).toBeUndefined();
  });

  test("an object element stays in children, with no items beside it", () => {
    const [rows] = paramsFromInputSchema({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
      },
    });
    expect(rows?.children?.map((c) => c.name)).toEqual(["a"]);
    expect(rows?.items).toBeUndefined();
  });

  test("an array with no declared element gets neither", () => {
    const [xs] = paramsFromInputSchema({
      type: "object",
      properties: { xs: { type: "array" } },
    });
    expect(xs?.type).toBe("array");
    expect(xs?.items).toBeUndefined();
    expect(xs?.children).toBeUndefined();
  });

  test("an array of arrays keeps both levels", () => {
    const [xs] = paramsFromInputSchema({
      type: "object",
      properties: { xs: { type: "array", items: { type: "array", items: { type: "number" } } } },
    });
    expect(xs?.items?.type).toBe("array");
    expect(xs?.items?.items?.type).toBe("number");
  });
});

describe("unions", () => {
  test("a nullable union is the type beside null", () => {
    const [note] = paramsFromInputSchema({
      type: "object",
      properties: {
        note: { description: "A note.", anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] },
      },
    });
    expect(note?.type).toBe("string");
    expect(note?.constraints.maxLength).toBe(200);
    expect(note?.description).toBe("A note.");
  });

  test("a union of objects reads as every field a caller may send", () => {
    // Written as a union and written plainly, this is the same body. Read as
    // unknown, the plain spelling in the next release reported every field
    // as added and one of them as newly required.
    const [body] = paramsFromInputSchema({
      type: "object",
      properties: {
        body: {
          anyOf: [
            { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
            {
              type: "object",
              properties: { prompt: { type: "string" }, buckets: { type: "array" } },
              required: ["prompt", "buckets"],
            },
          ],
        },
      },
    });
    expect(body?.type).toBe("object");
    expect(body?.children?.map((c) => [c.name, c.required])).toEqual([
      ["prompt", true],
      ["buckets", false],
    ]);
  });

  test("a union with no single type stays unknown", () => {
    // A string or a number has no one type to give it. Left unread on purpose:
    // the differ withholds claims against unknown instead of comparing it.
    const [page] = paramsFromInputSchema({
      type: "object",
      properties: { page: { anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "number" }] } },
    });
    expect(page?.type).toBe("unknown");
    expect(page?.constraints).toEqual({});
  });

  test("an explicit type beside a union is left alone", () => {
    const [id] = paramsFromInputSchema({
      type: "object",
      properties: { id: { type: "string", anyOf: [{ minLength: 1 }, { pattern: "^x" }] } },
    });
    expect(id?.type).toBe("string");
  });
});
