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

function paramFrom(name: string, schema: unknown, required: boolean, depth: number): Param {
  const raw = asSchema(schema);
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
): Tool {
  return {
    name,
    description: normalizeDescription(description),
    params: paramsFromInputSchema(inputSchema),
  };
}
