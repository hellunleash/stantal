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
  aliases: z.array(z.string()).optional(),
});
export type Tool = {
  name: string;
  description: string | null;
  params: Param[];
  /**
   * Other strings that identify this same operation in a consumer's code.
   *
   * A contract and the code calling it do not always agree on what a thing is
   * called. For a package they do: the tool is `tavily-search` and the consumer
   * writes `tavily-search`. For an HTTP API they never do. Stripe names an
   * operation `PostAccountSessions` and no consumer contains that string —
   * they write `/v1/account_sessions` or `stripe.accountSessions.create`.
   * Without the other names, Layer 3 returns nothing on every API, which is
   * the case where nothing else in a toolchain is looking either.
   *
   * **Derived, never authoritative.** The name is what the contract says and is
   * the only thing the diff compares. An alias is a way to find the operation
   * in somebody's source, so a wrong one costs a reach nobody can act on and
   * never a wrong claim about the contract itself.
   *
   * **Optional, and never defaulted to `[]`.** `JSON.stringify` drops an
   * undefined property, so a contract with no aliases serializes byte for byte
   * as it did before this field existed, and every cassette recorded against
   * one still matches.
   */
  aliases?: string[];
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
