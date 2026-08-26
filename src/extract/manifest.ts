import { toolFrom } from "../contract/from-json-schema.js";
import {
  fidelityOf,
  type ExtractionNote,
  type SurfaceAbsenceReason,
  type SurfaceResult,
} from "../contract/surface.js";
import { EXTRACTOR_VERSION, type Ecosystem, type Surface, type Tool } from "../contract/types.js";

/**
 * Manifest adapter — a contract that was already serialized to JSON.
 *
 * The other two extractors work for what a package *publishes*: boot the server
 * and ask it (`mcp.ts`), or read the shipped source without running it
 * (`module.ts`). Neither helps when the contract never went to a registry.
 *
 * A host that exposes its own API to an agent writes the tool set to a file, and
 * that file is the contract — the same descriptors, one serialization earlier.
 * It is also the artifact an API provider can hand over for a release they have
 * not published, which is the case the registry path cannot serve at all.
 *
 * Deliberately format-agnostic. It looks for a list of things that have a name
 * and a schema, wherever that list is; it does not check a `format` field or
 * key off a vendor. An MCP `tools/list` reply, the same reply inside a JSON-RPC
 * envelope, a bare array, and a host's own dump all read the same way, and a
 * reader keyed to one producer would be wrong the first time a second producer
 * appeared.
 */

export type ManifestExtractOptions = {
  /** The JSON text. Passed as text, not a path, so the caller owns all IO. */
  text: string;
  /** What to call this contract. A file has no registry identity of its own. */
  package: string;
  /** Caller-supplied: a commit, a tag, a date — whatever makes the pair ordered. */
  version: string;
  ecosystem?: Ecosystem;
  surface?: Surface;
  /** Filename used in evidence, so a note points at something openable. */
  origin?: string;
};

const ABSENCE_DETAIL: Record<SurfaceAbsenceReason, string> = {
  no_package_json: "the manifest carries no package identity",
  not_exported: "the manifest does not offer this surface",
  file_missing: "the manifest file was not supplied",
  unparseable: "the file is not parseable as a JSON tool manifest",
  no_descriptors: "the manifest lists no tools",
  descriptors_unreadable: "the manifest lists tools whose names are not readable strings",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the list of descriptors.
 *
 * Checked in order of how specific the claim is. A `tools` key means the
 * producer said "these are tools"; a bare top-level array only means "these are
 * things", so it is accepted last and only when it looks like descriptors.
 */
function toolList(root: unknown): unknown[] | null {
  if (isObject(root)) {
    if (Array.isArray(root["tools"])) return root["tools"];
    // JSON-RPC envelope: a captured `tools/list` reply, saved whole.
    const result = root["result"];
    if (isObject(result) && Array.isArray(result["tools"])) return result["tools"];
  }
  if (Array.isArray(root) && root.every((entry) => isObject(entry) && "name" in entry)) {
    return root;
  }
  return null;
}

/**
 * Read one descriptor.
 *
 * Every way of failing to read produces a note with a scope, never a silently
 * dropped or silently empty tool. The scope is what a later layer uses to
 * decide which claims it has earned: an unreadable name means the tool set
 * itself is in question, an unreadable schema means only that tool's
 * parameters are.
 */
function readDescriptor(
  entry: unknown,
  pointer: string,
): { tool: Tool | null; notes: ExtractionNote[] } {
  const notes: ExtractionNote[] = [];

  if (!isObject(entry)) {
    notes.push({
      code: "descriptor_name_unresolved",
      scope: "surface",
      target: null,
      evidence: pointer,
      detail: "manifest entry is not an object",
    });
    return { tool: null, notes };
  }

  const rawName = entry["name"];
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    notes.push({
      code: "descriptor_name_unresolved",
      scope: "surface",
      target: null,
      evidence: pointer,
      detail: "manifest entry has no readable `name`",
    });
    return { tool: null, notes };
  }
  const name = rawName.trim();

  // An absent `inputSchema` is the ordinary way to serialize a tool that takes
  // no arguments, so it is a fact and not a gap. A present one that is not an
  // object is a gap: something is there and we cannot read it. Reporting the
  // second as a zero-parameter tool would invent the exact kind of false
  // finding this product exists to catch.
  const schema = entry["inputSchema"] ?? entry["input_schema"] ?? entry["parameters"];
  if (schema !== undefined && !isObject(schema)) {
    notes.push({
      code: "descriptor_schema_unresolved",
      scope: "schema",
      target: name,
      evidence: pointer,
      detail: `\`${name}\` has an \`inputSchema\` that is not an object`,
    });
    return { tool: toolFrom(name, entry["description"], undefined), notes };
  }

  // `properties` present and unreadable is the same gap one level down: the
  // schema declares members and none of them can be listed.
  if (isObject(schema) && schema["properties"] !== undefined && !isObject(schema["properties"])) {
    notes.push({
      code: "descriptor_schema_unresolved",
      scope: "schema",
      target: name,
      evidence: pointer,
      detail: `\`${name}\` has \`inputSchema.properties\` that is not an object`,
    });
    return { tool: toolFrom(name, entry["description"], undefined), notes };
  }

  return { tool: toolFrom(name, entry["description"], schema), notes };
}

/**
 * A serialized tool manifest -> a surface result.
 *
 * Never throws on bad input. A file we cannot read is an *unevidenced* absence,
 * which `diffSurfaces` refuses to compare, rather than an empty contract, which
 * would diff as "every tool removed".
 */
export function extractFromManifest(options: ManifestExtractOptions): SurfaceResult {
  const {
    text,
    package: pkg,
    version,
    ecosystem = "http",
    surface = "host-pack",
    origin = "manifest.json",
  } = options;

  const absent = (reason: SurfaceAbsenceReason, checked: string[]): SurfaceResult => ({
    present: false,
    absence: {
      ecosystem,
      package: pkg,
      version,
      surface,
      reason,
      detail: ABSENCE_DETAIL[reason],
      checked,
    },
  });

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return absent("unparseable", [origin]);
  }

  const entries = toolList(root);
  // No recognizable list is *not* the same as an empty one. This file may not be
  // a tool manifest at all, and "it lists no tools" would be a claim about a
  // producer we have no evidence about.
  if (entries === null) return absent("unparseable", [`${origin}#/tools`]);
  if (entries.length === 0) return absent("no_descriptors", [`${origin}#/tools`]);

  const notes: ExtractionNote[] = [];
  const byName = new Map<string, Tool>();

  entries.forEach((entry, index) => {
    const read = readDescriptor(entry, `${origin}#/tools/${index}`);
    notes.push(...read.notes);
    if (read.tool === null) return;

    const existing = byName.get(read.tool.name);
    if (existing === undefined) {
      byName.set(read.tool.name, read.tool);
      return;
    }
    // Two descriptors for one name. The first wins so the read stays
    // deterministic, but which one a consumer actually gets is the producer's
    // business and not knowable from here, so the tool is no longer trusted.
    notes.push({
      code: "duplicate_descriptor",
      scope: "surface",
      target: read.tool.name,
      evidence: `${origin}#/tools/${index}`,
      detail: `\`${read.tool.name}\` is declared more than once`,
    });
  });

  // Every entry was unreadable. The surface is there — the file says so — but
  // nothing in it could be named, so this is our limit and not their absence.
  if (byName.size === 0) return absent("descriptors_unreadable", [`${origin}#/tools`]);

  const tools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  return {
    present: true,
    fidelity: fidelityOf(notes),
    notes,
    contract: {
      ecosystem,
      package: pkg,
      version,
      surface,
      extractedAt: new Date().toISOString(),
      extractorVersion: EXTRACTOR_VERSION,
      tools,
    },
  };
}
