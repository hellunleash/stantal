import type { Constraints, JsonType, Param, Tool } from "./types.js";

/**
 * JSON Schema -> normalized params.
 *
 * Shared by every extractor, since MCP servers, module packs and OpenAPI all
 * describe arguments as JSON Schema. Normalizing in one place keeps each new
 * source a config entry rather than new code.
 *
 * A parameter with no `description` normalizes to `null`, deliberately.
 */

type JsonSchemaish = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asSchema(v: unknown): JsonSchemaish {
  return isObject(v) ? (v as JsonSchemaish) : {};
}

function toJsonType(raw: JsonSchemaish): JsonType {
  const t = raw.type;
  const name = Array.isArray(t) ? t.find((x) => x !== "null") : t;
  switch (name) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
    case "array":
    case "null":
      return name;
    default:
      break;
  }
  // A union with no explicit type still tells us something is there.
  if (raw.anyOf || raw.oneOf || raw.allOf) return "unknown";
  if (raw.properties) return "object";
  if (raw.items) return "array";
  if (raw.enum && raw.enum.length > 0) {
    const first = raw.enum[0];
    if (typeof first === "string") return "string";
    if (typeof first === "number") return "number";
    if (typeof first === "boolean") return "boolean";
  }
  return "unknown";
}

function toConstraints(raw: JsonSchemaish): Constraints {
  const c: Constraints = {};
  if (raw.minLength !== undefined) c.minLength = raw.minLength;
  if (raw.maxLength !== undefined) c.maxLength = raw.maxLength;
  if (raw.minimum !== undefined) c.minimum = raw.minimum;
  if (raw.maximum !== undefined) c.maximum = raw.maximum;
  if (raw.pattern !== undefined) c.pattern = raw.pattern;
  if (raw.enum !== undefined) c.enum = raw.enum;
  if (raw.format !== undefined) c.format = raw.format;
  if (raw.default !== undefined) c.default = raw.default;
  return c;
}

/**
 * A description is only real if it carries guidance. Empty and whitespace-only
 * strings collapse to null so "shipped an empty string" and "shipped nothing"
 * compare as the same absence.
 */
export function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDescription(raw: JsonSchemaish): string | null {
  return normalizeDescription(raw.description);
}

/**
 * Read through a union where the union says only one thing.
 *
 * `anyOf` and `oneOf` used to normalize to `unknown` whatever was inside them,
 * and the differ then compared that `unknown` against the next release's plain
 * schema. Measured on a real API: a body written as a union of two objects read
 * as having no fields, so when the next spec wrote the same body plainly every
 * field in it was reported as added, one of them as a new required parameter.
 * Nothing had changed but the spelling.
 *
 * Two shapes are unambiguous and are read here:
 *
 * - **Nullable.** One real branch beside `null`. The parameter is that branch.
 * - **A union of objects.** A caller may send any branch, so the fields are the
 *   union of every branch's, and a field is required only where every branch
 *   requires it. That is the weakest reading, which is the safe direction: it
 *   can under-report a requirement and cannot invent one.
 *
 * Everything else stays `unknown`, because a union of a string and a number has
 * no single type to give it. The differ withholds claims against `unknown`
 * rather than comparing it, so leaving a union unread is a gap and never a
 * finding.
 *
 * An explicit `type` beside the union wins and nothing is rewritten.
 */
function throughUnion(raw: JsonSchemaish): JsonSchemaish {
  if (raw.type !== undefined) return raw;
  const union = raw.anyOf ?? raw.oneOf;
  if (!Array.isArray(union) || union.length === 0) return raw;

  const branches = union.map(asSchema).filter((branch) => branch.type !== "null");
  const { anyOf: _anyOf, oneOf: _oneOf, ...outer } = raw;

  if (branches.length === 1) {
    // What is written on the union itself is about this use of the type, so it
    // wins over the same key inside the branch.
    return throughUnion({ ...branches[0], ...outer });
  }

  if (branches.length > 1 && branches.every((branch) => isObject(branch.properties))) {
    const properties: Record<string, unknown> = {};
    for (const branch of branches) {
      for (const [key, sub] of Object.entries(branch.properties ?? {})) {
        if (!(key in properties)) properties[key] = sub;
      }
    }
    const required = Object.keys(properties).filter((key) =>
      branches.every((branch) => Array.isArray(branch.required) && branch.required.includes(key)),
    );
    return { ...outer, type: "object", properties, ...(required.length > 0 ? { required } : {}) };
  }

  return raw;
}

function paramFrom(name: string, schema: unknown, required: boolean, depth: number): Param {
  const raw = throughUnion(asSchema(schema));
  const type = toJsonType(raw);

  const param: Param = {
    name,
    type,
    required,
    description: toDescription(raw),
    constraints: toConstraints(raw),
    raw: schema,
  };

  // Depth cap keeps a recursive or self-referential schema from hanging the
  // extractor. Three levels is well past where tool arguments stay legible.
  if (depth >= 3) return param;

  if (type === "object" && isObject(raw.properties)) {
    param.children = childrenOf(raw, depth + 1);
  } else if (type === "array" && raw.items !== undefined) {
    const items = asSchema(raw.items);
    if (isObject(items.properties)) {
      param.children = childrenOf(items, depth + 1);
    } else {
      // An element that is not an object. `children` cannot hold it, and
      // without it `string[]` and `number[]` normalize to the same parameter.
      // Named `[]` and required so it sits on a dotted path beside every other
      // parameter and needs no special case in the differ.
      param.items = paramFrom("[]", raw.items, true, depth + 1);
    }
  }

  return param;
}

function childrenOf(raw: JsonSchemaish, depth: number): Param[] {
  const props = isObject(raw.properties) ? raw.properties : {};
  const requiredNames = new Set(Array.isArray(raw.required) ? raw.required : []);
  return Object.entries(props).map(([key, sub]) =>
    paramFrom(key, sub, requiredNames.has(key), depth),
  );
}

/** Top-level entry: an input schema for one tool becomes its parameter list. */
export function paramsFromInputSchema(inputSchema: unknown): Param[] {
  const raw = asSchema(inputSchema);
  if (!isObject(raw.properties)) return [];
  return childrenOf(raw, 0);
}

/** Build a normalized tool from the three things every surface provides. */
export function toolFrom(
  name: string,
  description: unknown,
  inputSchema: unknown,
  aliases?: unknown,
): Tool {
  // Spread rather than assigned, so a descriptor with no aliases produces a
  // tool with no `aliases` key at all. `JSON.stringify` drops an undefined
  // property but keeps an empty array, and an empty array here would change the
  // bytes of every contract ever recorded in a cassette.
  const named = Array.isArray(aliases)
    ? [...new Set(aliases.filter((a): a is string => typeof a === "string" && a.length > 0))]
    : [];

  return {
    name,
    description: normalizeDescription(description),
    params: paramsFromInputSchema(inputSchema),
    ...(named.length === 0 ? {} : { aliases: named }),
  };
}
