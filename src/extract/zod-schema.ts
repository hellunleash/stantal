import type { AnyNode, Expression, ObjectExpression } from "acorn";
import type { Constraints, JsonType, Param } from "../contract/types.js";
import { evaluate, isUnresolved, type BindingResolver } from "./js-literal.js";

/**
 * Reading a zod schema without running it.
 *
 * This exists because of a measured hole. Across the release histories walked so
 * far, four of six packages folded to **zero** parameters — not because they
 * ship none, but because they declare them with zod. `parameters: z.object(...)`
 * has no static value: every part of it is a function call, and calling it is
 * the one thing this extractor may never do. So the literal folder in
 * `js-literal.ts` correctly gave up, and the whole semantic layer went quiet.
 *
 * The way out is to stop asking for a value and start reading a *declaration*.
 * `z.string().optional().describe("...")` is a sentence about a parameter. Its
 * meaning is in the shape of the call chain, not in what the chain returns, and
 * the shape is right there in the AST.
 *
 * That is why this is a separate module rather than more cases inside
 * `evaluate`. `evaluate` answers "what is this expression's value?" and keeps a
 * hard promise that it never calls a function to find out. Teaching it to
 * understand `z.string()` would blur that promise. This reads structure and
 * returns a contract fragment; it never produces a value, so the promise stays
 * exactly as strong as it was.
 *
 * The rule that governs every decision below is the one the rest of the
 * extractor already follows: **never claim what the reading cannot support.**
 * Where a chain changes which fields exist, this refuses rather than guesses.
 */

/**
 * Looking up what a name was bound to, as a node.
 *
 * Carries its own context because a schema imported from another file resolves
 * its identifiers over there, not here.
 */
export type ZodContext = {
  /** The node a name was bound to, with the context that node lives in. */
  binding(name: string): { node: AnyNode; context: ZodContext } | null;
  /** Fold a plain literal expression — a description string, a `.min()` bound. */
  value(node: AnyNode): unknown;
};

/** A context that resolves nothing. Enough for a fully inline schema. */
export function inertContext(resolve: BindingResolver = () => undefined): ZodContext {
  const context: ZodContext = {
    binding: () => null,
    value: (node) => evaluate(node, resolve).value,
  };
  return context;
}

/** Something in the schema that could not be read, and what it blocks. */
export type ZodGap = {
  /** Dotted path inside the schema, e.g. `scrapeOptions` or `(root)`. */
  path: string;
  reason: string;
};

export type ZodShape = {
  params: Param[];
  gaps: ZodGap[];
};

/**
 * Chain methods that change which fields exist or which are required.
 *
 * Reading past one of these produces a parameter list that is confidently
 * wrong — the worst possible output for this product, because a wrong contract
 * diffs into invented findings. At the top level they are refused outright.
 */
const SHAPE_CHANGING = new Set([
  "omit",
  "pick",
  "partial",
  "deepPartial",
  "required",
  "extend",
  "merge",
  "and",
  "or",
]);

/** Wrappers whose schema argument is the thing we actually want. */
const UNWRAP_ARG: Record<string, number> = {
  preprocess: 1,
  transform: 0,
  pipe: 0,
  refine: 0,
  superRefine: 0,
  brand: 0,
  readonly: 0,
};

/** Base constructors, mapped to the JSON type they declare. */
const BASE_TYPE: Record<string, JsonType> = {
  string: "string",
  number: "number",
  bigint: "integer",
  boolean: "boolean",
  date: "string",
  symbol: "unknown",
  literal: "unknown",
  object: "object",
  strictObject: "object",
  looseObject: "object",
  record: "object",
  map: "object",
  array: "array",
  tuple: "array",
  set: "array",
  enum: "string",
  nativeEnum: "string",
  any: "unknown",
  unknown: "unknown",
  never: "unknown",
  void: "null",
  null: "null",
  undefined: "null",
  union: "unknown",
  discriminatedUnion: "unknown",
  intersection: "unknown",
  lazy: "unknown",
  instanceof: "unknown",
  custom: "unknown",
  function: "unknown",
  promise: "unknown",
  coerce: "unknown",
};

/** Does this identifier look like the zod namespace? */
function isZodRoot(name: string): boolean {
  return /^_{0,2}z(od)?[0-9_$]*$/i.test(name);
}

function isExpression(node: AnyNode | null | undefined): node is Expression {
  return node !== null && node !== undefined;
}

/** One link of a call chain, innermost first. */
type Link = { method: string; args: AnyNode[] };

/**
 * Flatten `z.string().min(1).describe("x")` into its base and its links.
 *
 * Returns null when the expression is not a chain rooted at something that looks
 * like zod. Deciding that by structure rather than by the name `z` matters:
 * built output renames imports freely, and a reader that only understood the
 * letter `z` would work on source and fail on everything published.
 */
type Chain = { base: string; baseArgs: AnyNode[]; links: Link[] };

function flatten(node: AnyNode): Chain | null {
  const links: Link[] = [];
  let cursor: AnyNode = node;

  // Walk inwards, collecting `.method(...)` calls until the base is reached.
  for (let step = 0; step < 64; step += 1) {
    if (cursor.type === "CallExpression") {
      const callee = cursor.callee as AnyNode;

      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        const method = callee.property.name;
        const object = callee.object as AnyNode;

        // `z.string(...)` — the base. Anything deeper is not a zod chain.
        if (object.type === "Identifier" && isZodRoot(object.name)) {
          return { base: method, baseArgs: [...(cursor.arguments as AnyNode[])], links: links.reverse() };
        }

        // `z.coerce.number()` — one more hop to the namespace.
        if (
          object.type === "MemberExpression" &&
          !object.computed &&
          object.object.type === "Identifier" &&
          isZodRoot(object.object.name)
        ) {
          return { base: method, baseArgs: [...(cursor.arguments as AnyNode[])], links: links.reverse() };
        }

        links.push({ method, args: [...(cursor.arguments as AnyNode[])] });
        cursor = object;
        continue;
      }

      return null;
    }

    // `Schema.shape` — the raw shape of a named object schema.
    if (cursor.type === "MemberExpression" && !cursor.computed && cursor.property.type === "Identifier") {
      links.push({ method: `.${cursor.property.name}`, args: [] });
      cursor = cursor.object as AnyNode;
      continue;
    }

    // An identifier base: a named schema constant, resolved by the caller.
    if (cursor.type === "Identifier") {
      return { base: `#${cursor.name}`, baseArgs: [], links: links.reverse() };
    }

    return null;
  }

  return null;
}

/**
 * Every value in this object literal is itself a zod chain — MCP's "raw shape".
 *
 * Two conditions, and the second one is a guard rather than a nicety. A bare
 * name flattens to a chain, so a JSON Schema fragment written as
 * `{ properties: PROPS, required: REQUIRED }` would otherwise qualify, and this
 * reader would report `properties` and `required` as two parameters. So at
 * least one value has to be a chain actually rooted at zod.
 */
function isRawShape(node: AnyNode): node is ObjectExpression {
  if (node.type !== "ObjectExpression") return false;
  const properties = node.properties.filter((p) => p.type === "Property");
  if (properties.length === 0) return false;

  const chains = properties.map((p) => flatten(p.value as AnyNode));
  if (chains.some((chain) => chain === null)) return false;
  return chains.some((chain) => chain !== null && !chain.base.startsWith("#"));
}

function propertyName(property: { key: AnyNode; computed: boolean }): string | null {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return null;
}

/**
 * Resolve an expression down to the object literal holding the fields.
 *
 * Handles the four shapes that actually ship: an inline `z.object({...})`, a
 * bare `{...}` of zod fields, a named constant, and `Schema.shape`.
 */
type Located = { literal: ObjectExpression; context: ZodContext };

function locateShape(node: AnyNode, context: ZodContext, depth = 0): Located | { refuse: string } | null {
  if (depth > 8) return { refuse: "the schema nests deeper than this reader follows" };

  if (isRawShape(node)) return { literal: node, context };

  const chain = flatten(node);
  if (chain === null) return null;

  for (const link of chain.links) {
    if (SHAPE_CHANGING.has(link.method)) {
      return {
        refuse: `\`.${link.method}()\` changes which fields exist; the parameter list was not read rather than guessed`,
      };
    }
  }

  // A wrapper: the schema is one of the arguments.
  const unwrapAt = UNWRAP_ARG[chain.base];
  if (unwrapAt !== undefined) {
    const inner = chain.baseArgs[unwrapAt];
    if (inner === undefined) return { refuse: `\`z.${chain.base}()\` was called without a schema to read` };
    return locateShape(inner, context, depth + 1);
  }

  if (chain.base === "object" || chain.base === "strictObject" || chain.base === "looseObject") {
    const literal = chain.baseArgs[0];
    if (literal === undefined || literal.type !== "ObjectExpression") {
      return { refuse: `\`z.${chain.base}()\` was not given an object literal` };
    }
    return { literal, context };
  }

  // A named constant, optionally with `.shape` on the end. Both mean the same
  // thing here: find what the name was bound to and read that.
  if (chain.base.startsWith("#")) {
    const bound = context.binding(chain.base.slice(1));
    if (bound === null) return null;
    return locateShape(bound.node, bound.context, depth + 1);
  }

  return null;
}

// --- Reading one field ------------------------------------------------------

type FieldRead = {
  type: JsonType;
  required: boolean;
  description: string | null;
  constraints: Constraints;
  children: Param[] | undefined;
  gaps: ZodGap[];
};

/**
 * Constraint methods, by the base type they qualify.
 *
 * `.min(1)` means a length on a string and a value on a number, so the base type
 * decides which constraint it becomes. Getting that backwards would make two
 * unrelated schemas diff as equal.
 */
function applyConstraint(
  constraints: Constraints,
  type: JsonType,
  method: string,
  args: readonly AnyNode[],
  context: ZodContext,
): void {
  const first = args[0];
  const value = first === undefined ? undefined : context.value(first);
  const numeric = typeof value === "number" ? value : undefined;

  const lengthish = type === "string" || type === "array";

  switch (method) {
    case "min":
    case "minLength":
      if (numeric === undefined) return;
      if (lengthish) constraints.minLength = numeric;
      else constraints.minimum = numeric;
      return;
    case "max":
    case "maxLength":
      if (numeric === undefined) return;
      if (lengthish) constraints.maxLength = numeric;
      else constraints.maximum = numeric;
      return;
    case "length":
      if (numeric === undefined) return;
      constraints.minLength = numeric;
      constraints.maxLength = numeric;
      return;
    case "gte":
    case "nonnegative":
      constraints.minimum = numeric ?? 0;
      return;
    case "lte":
      if (numeric !== undefined) constraints.maximum = numeric;
      return;
    case "positive":
      constraints.minimum = 1;
      return;
    case "regex":
      if (first?.type === "Literal" && "regex" in first && first.regex) {
        constraints.pattern = first.regex.pattern;
      }
      return;
    case "email":
    case "url":
    case "uuid":
    case "cuid":
    case "ulid":
    case "datetime":
    case "ip":
      constraints.format = method;
      return;
    default:
      return;
  }
}

/** Enum members, when every one of them is a literal. */
function enumValues(args: readonly AnyNode[], context: ZodContext): unknown[] | undefined {
  const first = args[0];
  if (first === undefined || first.type !== "ArrayExpression") return undefined;
  const values = first.elements.map((element) =>
    element === null || element.type === "SpreadElement" ? undefined : context.value(element as AnyNode),
  );
  if (values.some((v) => v === undefined || isUnresolved(v))) return undefined;
  return values;
}

function readField(node: AnyNode, path: string, context: ZodContext, depth: number): FieldRead | null {
  const chain = flatten(node);
  if (chain === null) return null;

  // A named field schema: read whatever the name points at, then apply this
  // chain's own modifiers on top.
  if (chain.base.startsWith("#")) {
    const bound = context.binding(chain.base.slice(1));
    if (bound === null) {
      return {
        type: "unknown",
        required: true,
        description: null,
        constraints: {},
        children: undefined,
        gaps: [{ path, reason: `the schema for \`${path}\` is a constant this reader could not follow` }],
      };
    }
    const inner = readField(bound.node, path, bound.context, depth + 1);
    if (inner === null) return null;
    return applyLinks(inner, chain.links, path, context, depth);
  }

  const type = BASE_TYPE[chain.base];
  if (type === undefined) return null;

  const constraints: Constraints = {};
  const gaps: ZodGap[] = [];
  let children: Param[] | undefined;
  let resolved: JsonType = type;

  if (chain.base === "enum" || chain.base === "nativeEnum") {
    const values = enumValues(chain.baseArgs, context);
    if (values !== undefined) constraints.enum = values;
  }

  if (chain.base === "literal") {
    const first = chain.baseArgs[0];
    const value = first === undefined ? undefined : context.value(first);
    if (typeof value === "string") resolved = "string";
    else if (typeof value === "number") resolved = "number";
    else if (typeof value === "boolean") resolved = "boolean";
    if (value !== undefined && !isUnresolved(value)) constraints.enum = [value];
  }

  // Nested members, so a change below the top level is still visible.
  if (depth < 4) {
    if (type === "object" && chain.base !== "record" && chain.base !== "map") {
      const nested = locateShape(node, context, 0);
      if (nested !== null && "literal" in nested) {
        const read = readShapeLiteral(nested.literal, nested.context, path, depth + 1);
        children = read.params;
        gaps.push(...read.gaps);
      } else if (nested !== null) {
        gaps.push({ path, reason: nested.refuse });
      }
    }

    if (type === "array") {
      const element = chain.baseArgs[0];
      if (element !== undefined) {
        const inner = readField(element, `${path}[]`, context, depth + 1);
        if (inner?.children !== undefined) children = inner.children;
        if (inner !== null) gaps.push(...inner.gaps);
      }
    }
  }

  const base: FieldRead = {
    type: resolved,
    required: true,
    description: null,
    constraints,
    children,
    gaps,
  };

  return applyLinks(base, chain.links, path, context, depth);
}

/**
 * Apply the modifiers hanging off a field's chain.
 *
 * Required-ness follows zod's real semantics, not a guess: a field is required
 * unless the chain makes the key itself omittable. `.nullable()` deliberately
 * does not — a nullable field still has to be passed, and treating it as
 * optional would invent an `undocumented_optional` finding on a required field.
 */
function applyLinks(
  read: FieldRead,
  links: readonly Link[],
  path: string,
  context: ZodContext,
  depth: number,
): FieldRead {
  const out: FieldRead = { ...read, constraints: { ...read.constraints }, gaps: [...read.gaps] };

  for (const link of links) {
    switch (link.method) {
      case "optional":
      case "nullish":
        out.required = false;
        break;

      case "default":
      case "prefault": {
        out.required = false;
        const first = link.args[0];
        const value = first === undefined ? undefined : context.value(first);
        if (value !== undefined && !isUnresolved(value)) out.constraints.default = value;
        break;
      }

      case "describe": {
        const first = link.args[0];
        const value = first === undefined ? undefined : context.value(first);
        if (typeof value === "string") out.description = value;
        else if (first !== undefined) {
          // A description that exists and could not be read must never look
          // like a description the package does not ship.
          out.gaps.push({
            path,
            reason: `\`${path}\` has a .describe() this reader could not fold to a string`,
          });
        }
        break;
      }

      case "nullable":
      case "readonly":
      case "brand":
      case "catch":
      case "strict":
      case "strip":
      case "passthrough":
      case "catchall":
        break;

      case "int":
      case "safe":
        out.type = "integer";
        break;

      case ".shape":
        break;

      default:
        if (SHAPE_CHANGING.has(link.method)) {
          out.gaps.push({
            path,
            reason: `\`.${link.method}()\` on \`${path}\` changes its members; they were not read`,
          });
          out.children = undefined;
        } else if (depth === 0 || out.type !== "unknown") {
          applyConstraint(out.constraints, out.type, link.method, link.args, context);
        }
        break;
    }
  }

  return out;
}

// --- Reading a whole shape --------------------------------------------------

function readShapeLiteral(
  literal: ObjectExpression,
  context: ZodContext,
  prefix: string,
  depth: number,
): ZodShape {
  const params: Param[] = [];
  const gaps: ZodGap[] = [];

  for (const property of literal.properties) {
    if (property.type !== "Property") {
      // A spread merges in fields we cannot enumerate, so the field list is no
      // longer provably complete.
      gaps.push({
        path: prefix === "" ? "(root)" : prefix,
        reason: "a spread element merges fields this reader cannot enumerate",
      });
      continue;
    }

    const name = propertyName(property);
    if (name === null) {
      gaps.push({
        path: prefix === "" ? "(root)" : prefix,
        reason: "a computed key hides a parameter name",
      });
      continue;
    }

    const path = prefix === "" ? name : `${prefix}.${name}`;
    if (!isExpression(property.value as AnyNode)) continue;

    const field = readField(property.value as AnyNode, path, context, depth);
    if (field === null) {
      gaps.push({ path, reason: `\`${path}\` is not a zod schema this reader understands` });
      continue;
    }

    gaps.push(...field.gaps);
    params.push({
      name,
      type: field.type,
      required: field.required,
      description: field.description,
      constraints: field.constraints,
      children: field.children,
    });
  }

  return { params, gaps };
}

/**
 * Read a zod schema expression into contract parameters.
 *
 * Returns null when the expression is not recognisably zod, so the caller keeps
 * whatever behaviour it had. Returns a refusal when it *is* zod but cannot be
 * read soundly — which the caller must report as a gap, never as an empty
 * parameter list.
 */
export type ZodReadResult = ZodShape | { refuse: string } | null;

export function readZodSchema(node: AnyNode, context: ZodContext): ZodReadResult {
  const located = locateShape(node, context, 0);
  if (located === null) return null;
  if ("refuse" in located) return located;
  return readShapeLiteral(located.literal, located.context, "", 0);
}

/**
 * Is this expression worth handing to the zod reader?
 *
 * A named constant counts. `inputSchema: ArgsSchema.shape` is the single most
 * common shape in published MCP servers, and its base is a name, not `z`.
 * Whether the name actually points at zod is settled by resolving it — this
 * only decides which reader gets the first look, and `readZodSchema` returns
 * null for anything that turns out not to be zod, so the caller falls back.
 */
export function looksLikeZod(node: AnyNode): boolean {
  if (isRawShape(node)) return true;
  return flatten(node) !== null;
}
