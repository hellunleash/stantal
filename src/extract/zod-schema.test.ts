import { parse } from "acorn";
import type { AnyNode, Expression, Program, VariableDeclaration } from "acorn";
import { describe, expect, it } from "vitest";
import { inertContext, looksLikeZod, readZodSchema, type ZodContext } from "./zod-schema.js";

/**
 * Reads `SCHEMA = <expression>` out of a snippet, so a test can name helper
 * constants above it exactly the way shipped code does.
 */
function context(source: string): { node: AnyNode; context: ZodContext } {
  const program: Program = parse(source, { ecmaVersion: "latest", sourceType: "module" });

  const bindings = new Map<string, AnyNode>();
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of (statement as VariableDeclaration).declarations) {
      if (declarator.id.type === "Identifier" && declarator.init !== null && declarator.init !== undefined) {
        bindings.set(declarator.id.name, declarator.init as AnyNode);
      }
    }
  }

  const node = bindings.get("SCHEMA");
  if (node === undefined) throw new Error("the snippet must declare SCHEMA");

  const base = inertContext();
  const ctx: ZodContext = {
    binding(name) {
      const found = bindings.get(name);
      return found === undefined ? null : { node: found, context: ctx };
    },
    value: base.value,
  };

  return { node, context: ctx };
}

function read(source: string) {
  const { node, context: ctx } = context(source);
  return readZodSchema(node, ctx);
}

function params(source: string) {
  const result = read(source);
  if (result === null) throw new Error("expected a zod schema, got null");
  if ("refuse" in result) throw new Error(`expected params, got refusal: ${result.refuse}`);
  return result;
}

function paramNamed(source: string, name: string) {
  const found = params(source).params.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no parameter named ${name}`);
  return found;
}

describe("finding the shape", () => {
  it("reads an inline z.object", () => {
    const { params: read } = params(`const SCHEMA = z.object({ url: z.string(), depth: z.number() });`);
    expect(read.map((p) => p.name)).toEqual(["url", "depth"]);
  });

  it("reads a raw shape — a bare object of zod fields", () => {
    // What `server.registerTool(name, { inputSchema: {...} })` actually passes.
    const { params: read } = params(`const SCHEMA = { path: z.string(), tail: z.number().optional() };`);
    expect(read.map((p) => p.name)).toEqual(["path", "tail"]);
  });

  it("follows a named constant", () => {
    const { params: read } = params(`
      const ArgsSchema = z.object({ path: z.string() });
      const SCHEMA = ArgsSchema;
    `);
    expect(read.map((p) => p.name)).toEqual(["path"]);
  });

  it("follows Schema.shape", () => {
    const { params: read } = params(`
      const ArgsSchema = z.object({ path: z.string(), head: z.number().optional() });
      const SCHEMA = ArgsSchema.shape;
    `);
    expect(read.map((p) => p.name)).toEqual(["path", "head"]);
  });

  it("unwraps z.preprocess to the schema it wraps", () => {
    // The first argument is a call we cannot evaluate. We do not need to: the
    // schema is the second one.
    const { params: read } = params(`
      const SCHEMA = z.preprocess(normalise(ALIASES), z.object({ query: z.string() }));
    `);
    expect(read.map((p) => p.name)).toEqual(["query"]);
  });

  it("reads through a namespace named something other than z", () => {
    // Built output renames imports freely; a reader that only knew `z` would
    // work on source and fail on everything published.
    expect(params(`const SCHEMA = zod.object({ a: zod.string() });`).params).toHaveLength(1);
    expect(params(`const SCHEMA = z2.object({ a: z2.string() });`).params).toHaveLength(1);
  });

  it("returns null for a plain JSON Schema, so the existing reader keeps it", () => {
    expect(
      read(`const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };`),
    ).toBeNull();
  });

  it("does not mistake a JSON Schema assembled from constants for a raw shape", () => {
    // Every value here flattens to a name, and without a guard this would be
    // reported as two parameters called `properties` and `required`.
    expect(read(`const SCHEMA = { properties: PROPS, required: REQUIRED };`)).toBeNull();
  });
});

describe("required-ness follows zod, not a guess", () => {
  it("treats a bare field as required", () => {
    expect(paramNamed(`const SCHEMA = z.object({ a: z.string() });`, "a").required).toBe(true);
  });

  it("treats .optional() and .nullish() as optional", () => {
    const source = `const SCHEMA = z.object({ a: z.string().optional(), b: z.string().nullish() });`;
    expect(paramNamed(source, "a").required).toBe(false);
    expect(paramNamed(source, "b").required).toBe(false);
  });

  it("treats .default() as optional and keeps the default", () => {
    const param = paramNamed(`const SCHEMA = z.object({ a: z.boolean().default(false) });`, "a");
    expect(param.required).toBe(false);
    expect(param.constraints.default).toBe(false);
  });

  it("keeps .nullable() required", () => {
    // A nullable field still has to be passed. Calling it optional would invent
    // an `undocumented_optional` finding on a required parameter.
    expect(paramNamed(`const SCHEMA = z.object({ a: z.string().nullable() });`, "a").required).toBe(true);
  });
});

describe("reading a field chain", () => {
  it("reads .describe() as the parameter description", () => {
    const param = paramNamed(
      `const SCHEMA = z.object({ tail: z.number().optional().describe("last N lines") });`,
      "tail",
    );
    expect(param.description).toBe("last N lines");
    expect(param.type).toBe("number");
  });

  it("leaves a field with no .describe() as null, not empty string", () => {
    expect(paramNamed(`const SCHEMA = z.object({ a: z.string() });`, "a").description).toBeNull();
  });

  it("records a gap when .describe() cannot be folded to a string", () => {
    // A description that exists and could not be read must never look like a
    // description the package does not ship.
    const result = params(`const SCHEMA = z.object({ a: z.string().describe(buildText()) });`);
    expect(result.params[0]?.description).toBeNull();
    expect(result.gaps.map((g) => g.path)).toContain("a");
  });

  it("maps base constructors to json types", () => {
    const source = `const SCHEMA = z.object({
      s: z.string(), n: z.number(), b: z.boolean(), a: z.array(z.string()), o: z.object({ x: z.string() })
    });`;
    const byName = new Map(params(source).params.map((p) => [p.name, p.type]));
    expect(byName.get("s")).toBe("string");
    expect(byName.get("n")).toBe("number");
    expect(byName.get("b")).toBe("boolean");
    expect(byName.get("a")).toBe("array");
    expect(byName.get("o")).toBe("object");
  });

  it("reads an enum as its members", () => {
    const param = paramNamed(`const SCHEMA = z.object({ sortBy: z.enum(["name", "size"]) });`, "sortBy");
    expect(param.type).toBe("string");
    expect(param.constraints.enum).toEqual(["name", "size"]);
  });

  it("reads .int() as an integer", () => {
    expect(paramNamed(`const SCHEMA = z.object({ n: z.number().int() });`, "n").type).toBe("integer");
  });
});

describe("constraints depend on the base type", () => {
  it("reads .min on a string as a length", () => {
    const param = paramNamed(`const SCHEMA = z.object({ a: z.string().min(1) });`, "a");
    expect(param.constraints.minLength).toBe(1);
    expect(param.constraints.minimum).toBeUndefined();
  });

  it("reads .min on a number as a value", () => {
    // Getting this backwards would make two unrelated schemas diff as equal.
    const param = paramNamed(`const SCHEMA = z.object({ a: z.number().min(1).max(10) });`, "a");
    expect(param.constraints.minimum).toBe(1);
    expect(param.constraints.maximum).toBe(10);
    expect(param.constraints.minLength).toBeUndefined();
  });

  it("reads a format helper", () => {
    expect(paramNamed(`const SCHEMA = z.object({ a: z.string().url() });`, "a").constraints.format).toBe("url");
  });
});

describe("nested members stay visible", () => {
  it("reads the members of a nested object", () => {
    const param = paramNamed(
      `const SCHEMA = z.object({ opts: z.object({ deep: z.boolean(), name: z.string() }) });`,
      "opts",
    );
    expect(param.children?.map((c) => c.name)).toEqual(["deep", "name"]);
  });

  it("reads the members of an array element, through a named constant", () => {
    const param = paramNamed(
      `
      const Edit = z.object({ oldText: z.string(), newText: z.string() });
      const SCHEMA = z.object({ edits: z.array(Edit) });
      `,
      "edits",
    );
    expect(param.type).toBe("array");
    expect(param.children?.map((c) => c.name)).toEqual(["oldText", "newText"]);
  });
});

describe("refusing what it cannot prove", () => {
  it("refuses a top-level .partial(), which makes every field optional", () => {
    const result = read(`
      const Base = z.object({ a: z.string(), b: z.string() });
      const SCHEMA = Base.partial();
    `);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("refuse");
  });

  it("refuses a top-level .omit(), which removes fields", () => {
    const result = read(`
      const Base = z.object({ a: z.string(), b: z.string() });
      const SCHEMA = Base.omit({ b: true });
    `);
    expect(result).toHaveProperty("refuse");
  });

  it("refuses a top-level .extend(), which adds them", () => {
    const result = read(`
      const Base = z.object({ a: z.string() });
      const SCHEMA = Base.extend({ b: z.string() });
    `);
    expect(result).toHaveProperty("refuse");
  });

  it("keeps a field whose members are unreadable, and records the gap", () => {
    // The field itself is real and its optionality is known. Only its members
    // are unknown, so only its members are withheld.
    const result = params(`
      const Base = z.object({ a: z.string() });
      const SCHEMA = z.object({ url: z.string(), opts: Base.omit({ a: true }).partial().optional() });
    `);
    const opts = result.params.find((p) => p.name === "opts");
    expect(result.params.map((p) => p.name)).toEqual(["url", "opts"]);
    expect(opts?.required).toBe(false);
    expect(opts?.children).toBeUndefined();
    expect(result.gaps.some((g) => g.path === "opts")).toBe(true);
  });

  it("records a gap for a spread, which hides fields it cannot enumerate", () => {
    const result = params(`const SCHEMA = z.object({ ...BASE_FIELDS, url: z.string() });`);
    expect(result.gaps.some((g) => g.path === "(root)")).toBe(true);
    expect(result.params.map((p) => p.name)).toEqual(["url"]);
  });

  it("records a gap for a computed key, which hides a parameter name", () => {
    const result = params(`const SCHEMA = z.object({ [FIELD]: z.string(), url: z.string() });`);
    expect(result.gaps.some((g) => g.path === "(root)")).toBe(true);
  });
});

describe("looksLikeZod", () => {
  it("accepts a named constant, because Schema.shape is the common case", () => {
    const { node } = context(`const SCHEMA = ArgsSchema.shape;`);
    expect(looksLikeZod(node)).toBe(true);
  });

  it("rejects a JSON Schema object literal", () => {
    const { node } = context(`const SCHEMA = { type: "object", properties: {} };`);
    expect(looksLikeZod(node)).toBe(false);
  });
});
