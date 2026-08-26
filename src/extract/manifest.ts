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

/** One document. Text, not a path, so the caller owns all IO. */
export type ManifestSource = {
  text: string;
  /** Filename used in evidence, so a note points at something openable. */
  origin?: string;
};

export type ManifestExtractOptions = {
  /** A single document. Shorthand for a one-entry `sources`. */
  text?: string;
  /**
   * The documents that together make up one contract, catalog first.
   *
   * A contract is not always one file. A host commonly generates the schemas
   * from its own routes and keeps the prose somewhere editable, because the two
   * have different authors: one is regenerated on every build, the other is
   * written once by a person. What a model receives is the merge, so reading
   * only the file that happens to be named `tools` reports the schemas of the
   * real contract next to the descriptions of neither.
   *
   * **The first source defines the tool set; later ones refine it.** Order is
   * the only signal available for which document is the catalog, and it is the
   * right one — an annotation file cannot introduce a tool the host does not
   * serve. An entry in a later source naming a tool no earlier source declared
   * therefore describes nothing and is ignored. That is deliberately not a
   * note: notes exist for gaps that suppress claims, and here the contract is
   * fully known.
   */
  sources?: readonly ManifestSource[];
  /** What to call this contract. A file has no registry identity of its own. */
  package: string;
  /** Caller-supplied: a commit, a tag, a date — whatever makes the pair ordered. */
  version: string;
  ecosystem?: Ecosystem;
  surface?: Surface;
  /** Filename used in evidence, so a note points at something openable. */
  origin?: string;
  /**
   * Where a descriptor's fields live, when a document nests them.
   *
   * A producer that separates generated fields from editable ones puts the
   * editable half under a wrapper. Named by the caller rather than guessed:
   * picking a nesting key by sniffing would silently read the wrong object the
   * first time a producer chose a different name, and a description read off
   * the wrong object is exactly the false finding this tool exists to catch.
   */
  fieldsKey?: string;
  /**
   * Tools the runtime withholds from the model, as a predicate over the
   * merged descriptor.
   *
   * Some of what decides the tool set is policy the documents state but do not
   * apply — a grade meaning "operators only" is in the file, while the rule
   * that such tools are hidden lives in the host. Stantal cannot infer that
   * rule and must not guess it, so the caller states it. Left unset, nothing is
   * excluded and the contract is every tool declared.
   */
  excludeWhen?: readonly { key: string; value: string }[];
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
    // A map of name -> descriptor. Common wherever a document is meant to be
    // looked up by tool rather than iterated, which is how annotation files are
    // usually written. The key is the identity, so it wins over any `name`
    // inside the value: in a map the two disagreeing means the value is stale,
    // and the entry still describes whatever the key names.
    if (isObject(root["tools"])) {
      return Object.entries(root["tools"]).map(([name, value]) => ({
        ...(isObject(value) ? value : {}),
        name,
      }));
    }
    // JSON-RPC envelope: a captured `tools/list` reply, saved whole.
    const result = root["result"];
    if (isObject(result) && Array.isArray(result["tools"])) return result["tools"];
  }
  if (Array.isArray(root) && root.every((entry) => isObject(entry) && "name" in entry)) {
    return root;
  }
  return null;
}

/** The schema, under any of the spellings producers use for it. */
function schemaOf(record: Record<string, unknown>): unknown {
  return record["inputSchema"] ?? record["input_schema"] ?? record["parameters"];
}

/**
 * One descriptor, read but not yet turned into a tool.
 *
 * Kept as a record rather than a `Tool` because merging happens across
 * documents: a later source may supply only the description, and building a
 * tool per source would mean rebuilding one from a fragment that never had a
 * schema and calling the missing parameters a fact.
 */
type Descriptor = {
  name: string;
  record: Record<string, unknown>;
  /** A schema is present and could not be read, so its parameters are unknown. */
  schemaUnreadable: boolean;
};

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
  fieldsKey: string | undefined,
): { descriptor: Descriptor | null; notes: ExtractionNote[] } {
  const notes: ExtractionNote[] = [];

  if (!isObject(entry)) {
    notes.push({
      code: "descriptor_name_unresolved",
      scope: "surface",
      target: null,
      evidence: pointer,
      detail: "manifest entry is not an object",
    });
    return { descriptor: null, notes };
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
    return { descriptor: null, notes };
  }
  const name = rawName.trim();

  // Nested fields are folded up so everything downstream reads one flat record.
  // The wrapper wins over the top level: it is where a producer puts the value
  // a person edited, and the outer copy is the generated one it supersedes.
  const nested = fieldsKey === undefined ? undefined : entry[fieldsKey];
  const record: Record<string, unknown> = { ...entry, ...(isObject(nested) ? nested : {}) };

  // An absent schema is the ordinary way to serialize a tool that takes no
  // arguments, so it is a fact and not a gap. A present one that is not an
  // object is a gap: something is there and we cannot read it. Reporting the
  // second as a zero-parameter tool would invent the exact kind of false
  // finding this product exists to catch.
  const schema = schemaOf(record);
  const unreadable =
    (schema !== undefined && !isObject(schema)) ||
    (isObject(schema) && schema["properties"] !== undefined && !isObject(schema["properties"]));

  if (unreadable) {
    notes.push({
      code: "descriptor_schema_unresolved",
      scope: "schema",
      target: name,
      evidence: pointer,
      detail: `\`${name}\` has an \`inputSchema\` that could not be read`,
    });
  }

  return { descriptor: { name, record, schemaUnreadable: unreadable }, notes };
}

/** Does this tool match a rule saying the runtime withholds it? */
function withheld(
  record: Record<string, unknown>,
  rules: readonly { key: string; value: string }[],
): boolean {
  return rules.some((rule) => {
    const actual = record[rule.key];
    return actual !== undefined && String(actual) === rule.value;
  });
}

/**
 * A serialized tool manifest -> a surface result.
 *
 * Never throws on bad input. A document we cannot read is an *unevidenced*
 * absence, which `diffSurfaces` refuses to compare, rather than an empty
 * contract, which would diff as "every tool removed".
 */
export function extractFromManifest(options: ManifestExtractOptions): SurfaceResult {
  const {
    package: pkg,
    version,
    ecosystem = "http",
    surface = "host-pack",
    origin = "manifest.json",
    fieldsKey,
    excludeWhen = [],
  } = options;

  const sources: readonly ManifestSource[] =
    options.sources ?? (options.text === undefined ? [] : [{ text: options.text, origin }]);

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

  if (sources.length === 0) return absent("file_missing", [origin]);

  const notes: ExtractionNote[] = [];
  const merged = new Map<string, Descriptor>();
  let firstSource = true;

  for (const source of sources) {
    const where = source.origin ?? origin;

    let root: unknown;
    try {
      root = JSON.parse(source.text);
    } catch {
      return absent("unparseable", [where]);
    }

    const entries = toolList(root);
    // No recognizable list is *not* the same as an empty one. This document may
    // not be a tool manifest at all, and "it lists no tools" would be a claim
    // about a producer we have no evidence about.
    if (entries === null) return absent("unparseable", [`${where}#/tools`]);
    if (entries.length === 0 && firstSource) return absent("no_descriptors", [`${where}#/tools`]);

    const seenHere = new Set<string>();

    entries.forEach((entry, index) => {
      const pointer = `${where}#/tools/${index}`;
      const read = readDescriptor(entry, pointer, fieldsKey);
      notes.push(...read.notes);
      if (read.descriptor === null) return;

      const { name, record, schemaUnreadable } = read.descriptor;

      // Two descriptors for one name *within one document*. The first wins so
      // the read stays deterministic, but which one a consumer actually gets is
      // the producer's business and not knowable from here, so it is noted.
      // Across documents the same name is the point, not a conflict.
      if (seenHere.has(name)) {
        notes.push({
          code: "duplicate_descriptor",
          scope: "surface",
          target: name,
          evidence: pointer,
          detail: `\`${name}\` is declared more than once in ${where}`,
        });
        return;
      }
      seenHere.add(name);

      const existing = merged.get(name);
      if (existing === undefined) {
        // Only the catalog may introduce a tool. A later document naming one
        // nothing declares describes nothing, and is dropped rather than
        // turned into a tool with prose and no schema.
        if (firstSource) merged.set(name, { name, record, schemaUnreadable });
        return;
      }

      merged.set(name, {
        name,
        record: { ...existing.record, ...record },
        // Unreadable anywhere is unreadable: a later document that carries no
        // schema must not clear a gap an earlier one reported.
        schemaUnreadable: existing.schemaUnreadable || schemaUnreadable,
      });
    });

    firstSource = false;
  }

  // Every entry was unreadable. The surface is there — the documents say so —
  // but nothing in them could be named, so this is our limit and not their
  // absence.
  if (merged.size === 0) return absent("descriptors_unreadable", [`${origin}#/tools`]);

  const tools: Tool[] = [];
  for (const { name, record, schemaUnreadable } of merged.values()) {
    if (withheld(record, excludeWhen)) continue;
    tools.push(toolFrom(name, record["description"], schemaUnreadable ? undefined : schemaOf(record)));
  }

  // Excluding every tool is a fact about the rules the caller supplied, not a
  // reading gap — but it is still not a contract, and comparing it as one would
  // read as every tool removed.
  if (tools.length === 0) return absent("no_descriptors", [`${origin}#/tools`]);

  tools.sort((a, b) => a.name.localeCompare(b.name));

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
