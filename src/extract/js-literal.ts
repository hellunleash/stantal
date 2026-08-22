import type { AnyNode } from "acorn";

/**
 * Literal folding over a parsed module.
 *
 * A shipped tool descriptor is an object literal, but its name and description
 * are routinely pulled from constants. Reading the contract without running the
 * package therefore needs a small evaluator: enough to fold literals, template
 * strings, string concatenation, spreads and constant references — and nothing
 * more.
 *
 * It never calls a function and never takes a branch. Anything it cannot fold is
 * reported as unresolved rather than guessed, because a guessed description is
 * worse than a missing one: the whole product rests on telling "this contract
 * ships no guidance" apart from "we could not read the guidance".
 */

export const UNRESOLVED: unique symbol = Symbol("stantal.unresolved");
export type Unresolved = typeof UNRESOLVED;

export function isUnresolved(value: unknown): value is Unresolved {
  return value === UNRESOLVED;
}

/** Resolves a free identifier to a value, or UNRESOLVED when it cannot. */
export type BindingResolver = (name: string) => unknown;

const NO_BINDINGS: BindingResolver = () => UNRESOLVED;

/**
 * A folded value plus every path inside it that could not be folded.
 *
 * The paths are what make a partial read safe to use. A caller that cares about
 * `description` can ask whether `description` is in the list, instead of seeing
 * an absent key and concluding the package shipped nothing there.
 */
export type Evaluation = {
  /** UNRESOLVED when the expression itself could not be folded at all. */
  value: unknown;
  /** Dotted paths, relative to the evaluated expression, that were dropped. */
  unresolved: string[];
};

/** Nesting cap. Well past where a tool schema stays legible, and stops a pathological input. */
const MAX_DEPTH = 16;

type Ctx = {
  resolve: BindingResolver;
  unresolved: string[];
};

function record(ctx: Ctx, path: string): Unresolved {
  ctx.unresolved.push(path === "" ? "<root>" : path);
  return UNRESOLVED;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Only primitives concatenate or interpolate. Objects stringify to noise. */
function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function propertyKey(node: AnyNode, ctx: Ctx, path: string, depth: number): string | null {
  if (node.type !== "Property") return null;
  if (node.kind !== "init" || node.method) return null; // a getter's value is behaviour, not data
  if (node.computed) {
    const key = evalNode(node.key as AnyNode, ctx, path, depth + 1);
    return typeof key === "string" || typeof key === "number" ? String(key) : null;
  }
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal") {
    const raw = node.key.value;
    return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  }
  return null;
}

function evalObject(node: AnyNode, ctx: Ctx, path: string, depth: number): unknown {
  if (node.type !== "ObjectExpression") return record(ctx, path);
  const out: Record<string, unknown> = {};

  for (const prop of node.properties) {
    if (prop.type === "SpreadElement") {
      // A spread we cannot read leaves unknown keys in the object. Reporting the
      // rest as if it were whole would understate the contract, so the object goes.
      const spread = evalNode(prop.argument as AnyNode, ctx, path, depth + 1);
      if (!isPlainObject(spread)) return record(ctx, path);
      Object.assign(out, spread);
      continue;
    }

    const key = propertyKey(prop as AnyNode, ctx, path, depth);
    if (key === null) {
      record(ctx, join(path, "<computed>"));
      continue;
    }

    const value = evalNode(prop.value as AnyNode, ctx, join(path, key), depth + 1);
    // An unreadable value drops its key and says so. The path is what lets a
    // caller tell "absent from the package" from "absent from our read".
    if (isUnresolved(value)) continue;
    out[key] = value;
  }

  return out;
}

function evalArray(node: AnyNode, ctx: Ctx, path: string, depth: number): unknown {
  if (node.type !== "ArrayExpression") return record(ctx, path);
  const out: unknown[] = [];

  for (const [index, element] of node.elements.entries()) {
    if (element === null) return record(ctx, path); // a hole
    if (element.type === "SpreadElement") {
      const spread = evalNode(element.argument as AnyNode, ctx, path, depth + 1);
      if (!Array.isArray(spread)) return record(ctx, path);
      out.push(...spread);
      continue;
    }
    const value = evalNode(element as AnyNode, ctx, `${path}[${index}]`, depth + 1);
    // Arrays in a contract are meaningful as wholes — `required`, `enum`. A
    // partial one would read as a narrower contract than the package ships.
    if (isUnresolved(value)) return record(ctx, path);
    out.push(value);
  }

  return out;
}

function evalTemplate(node: AnyNode, ctx: Ctx, path: string, depth: number): unknown {
  if (node.type !== "TemplateLiteral") return record(ctx, path);
  let out = "";
  for (const [index, quasi] of node.quasis.entries()) {
    out += quasi.value.cooked ?? quasi.value.raw;
    const expression = node.expressions[index];
    if (expression === undefined) continue;
    const value = evalNode(expression as AnyNode, ctx, path, depth + 1);
    if (!isPrimitive(value)) return record(ctx, path);
    out += String(value);
  }
  return out;
}

function evalNode(node: AnyNode, ctx: Ctx, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return record(ctx, path);

  switch (node.type) {
    case "Literal": {
      // A RegExp or BigInt has no JSON value, so it is not contract data we can compare.
      if (node.regex !== undefined || node.bigint !== undefined) return record(ctx, path);
      return node.value === undefined ? record(ctx, path) : node.value;
    }

    case "Identifier": {
      if (node.name === "undefined") return undefined;
      const value = ctx.resolve(node.name);
      return isUnresolved(value) ? record(ctx, path) : value;
    }

    case "TemplateLiteral":
      return evalTemplate(node, ctx, path, depth);

    case "ObjectExpression":
      return evalObject(node, ctx, path, depth);

    case "ArrayExpression":
      return evalArray(node, ctx, path, depth);

    case "UnaryExpression": {
      const argument = evalNode(node.argument as AnyNode, ctx, path, depth + 1);
      if (node.operator === "-" && typeof argument === "number") return -argument;
      if (node.operator === "+" && typeof argument === "number") return argument;
      if (node.operator === "!" && isPrimitive(argument)) return !argument;
      return record(ctx, path);
    }

    case "BinaryExpression": {
      // Long descriptions are often assembled with `+`. Nothing else folds.
      if (node.operator !== "+") return record(ctx, path);
      if (node.left.type === "PrivateIdentifier") return record(ctx, path);
      const left = evalNode(node.left as AnyNode, ctx, path, depth + 1);
      const right = evalNode(node.right as AnyNode, ctx, path, depth + 1);
      if (typeof left === "string" && isPrimitive(right)) return left + String(right);
      if (typeof right === "string" && isPrimitive(left)) return String(left) + right;
      if (typeof left === "number" && typeof right === "number") return left + right;
      return record(ctx, path);
    }

    case "MemberExpression": {
      // `SCHEMAS.create` and `SCHEMAS["create"]` are common ways to share a schema.
      if (node.object.type === "Super") return record(ctx, path);
      const target = evalNode(node.object as AnyNode, ctx, path, depth + 1);
      if (!isPlainObject(target) && !Array.isArray(target)) return record(ctx, path);

      let key: string | null = null;
      if (!node.computed && node.property.type === "Identifier") {
        key = node.property.name;
      } else if (node.computed) {
        const evaluated = evalNode(node.property as AnyNode, ctx, path, depth + 1);
        if (typeof evaluated === "string" || typeof evaluated === "number") key = String(evaluated);
      }
      if (key === null) return record(ctx, path);

      const container = target as Record<string, unknown>;
      return key in container ? container[key] : record(ctx, path);
    }

    default:
      // Calls, conditionals, functions, `new`, everything else. Running any of
      // it is exactly what this extractor exists to avoid.
      return record(ctx, path);
  }
}

/** Fold one expression as far as literals allow. */
export function evaluate(node: AnyNode, resolve: BindingResolver = NO_BINDINGS): Evaluation {
  const ctx: Ctx = { resolve, unresolved: [] };
  const value = evalNode(node, ctx, "", 0);
  return { value, unresolved: ctx.unresolved };
}
