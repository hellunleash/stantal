import { z } from "zod";

/**
 * The normalized contract.
 *
 * One shape for every ecosystem — MCP servers, module packs, OpenAPI. Every
 * comparison step is typed against this, never against a native format.
 *
 * Two decisions here are load-bearing:
 *
 * 1. `description` is `string | null`, never `string | undefined`. An absent
 *    description is a fact worth recording, not a missing field.
 *
 * 2. A contract belongs to a `surface`, not just a version. One package can
 *    hand different tool sets to different consumers, and the difference
 *    between two surfaces of the same version is itself a finding.
 */

export const JsonTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
  "unknown",
]);
export type JsonType = z.infer<typeof JsonTypeSchema>;

/**
 * Constraints kept as a narrow, comparable set rather than raw JSON Schema.
 * The differ compares these directly; anything not modelled here stays in `raw` so
 * extraction is never lossy.
 */
export const ConstraintsSchema = z.object({
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  pattern: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  format: z.string().optional(),
  default: z.unknown().optional(),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export type Param = {
  name: string;
  type: JsonType;
  required: boolean;
  description: string | null;
  constraints: Constraints;
  // `| undefined` is required under exactOptionalPropertyTypes for zod's
  // `.optional()` to line up with the hand-written type.
  children?: Param[] | undefined;
  raw?: unknown;
};

export const ParamSchema: z.ZodType<Param> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: JsonTypeSchema,
    required: z.boolean(),
    /** null means the contract ships no guidance for this parameter. */
    description: z.string().nullable(),
    constraints: ConstraintsSchema,
    /** Nested object/array members, so shape changes below the top level are visible. */
    children: z.array(ParamSchema).optional(),
    /** The untouched schema fragment, so extraction loses nothing. */
    raw: z.unknown().optional(),
  }),
);

export const ToolSchema = z.object({
  name: z.string(),
  /** null means the tool ships with no description at all. */
  description: z.string().nullable(),
  params: z.array(ParamSchema),
});
export type Tool = {
  name: string;
  description: string | null;
  params: Param[];
};

/**
 * Which door of the package this contract came out of.
 *
 * One package can expose several surfaces, and the contract on each is read
 * independently. They are not assumed to agree.
 */
export const SurfaceSchema = z.enum([
  "mcp-server",
  "host-pack",
  "openapi",
  "http-discovery",
]);
export type Surface = z.infer<typeof SurfaceSchema>;

export const EcosystemSchema = z.enum(["npm", "pypi", "http"]);
export type Ecosystem = z.infer<typeof EcosystemSchema>;

export const ContractSchema = z.object({
  ecosystem: EcosystemSchema,
  package: z.string(),
  version: z.string(),
  surface: SurfaceSchema,
  extractedAt: z.string(),
  /** Extractor identity, so a cached contract can be invalidated by a fix. */
  extractorVersion: z.string(),
  tools: z.array(ToolSchema),
});
export type Contract = {
  ecosystem: Ecosystem;
  package: string;
  version: string;
  surface: Surface;
  extractedAt: string;
  extractorVersion: string;
  tools: Tool[];
};

/** Bump when extraction changes shape or fidelity; invalidates the cache. */
export const EXTRACTOR_VERSION = "1";

/** Stable identity of a cached contract. Versions are immutable, so this never changes meaning. */
export function contractKey(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  surface: Surface,
): string {
  return `${ecosystem}/${pkg}/${version}/${surface}/${EXTRACTOR_VERSION}`;
}
