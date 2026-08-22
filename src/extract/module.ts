import type { AnyNode, Expression, ObjectExpression, Property } from "acorn";
import { toolFrom } from "../contract/from-json-schema.js";
import {
  fidelityOf,
  type ExtractionNote,
  type SurfaceAbsenceReason,
  type SurfaceResult,
} from "../contract/surface.js";
import { EXTRACTOR_VERSION, type Contract, type Ecosystem, type Surface, type Tool } from "../contract/types.js";
import { evaluate, isUnresolved } from "./js-literal.js";
import { ModuleGraph, type ParsedModule } from "./module-bindings.js";
import { resolveEntryPoint, type EntryCondition, type PackageSource } from "./package-source.js";

/**
 * Module-pack adapter.
 *
 * Reads the tool descriptors a package hands a host loop, out of the exact file
 * the host's entry point resolves to.
 *
 * Two rules shape this:
 *
 * 1. **Per surface, never per package.** A package can hand different tool sets
 *    to different doors, and prose present on one door can be absent from
 *    another. Searching the package for a sentence would find it wherever it
 *    lives and report no problem. So extraction is pinned to one entry point,
 *    plus the barrel files that entry point re-exports — nothing else.
 *
 * 2. **Read, never run.** The descriptors are folded out of the source text.
 *    Installing hundreds of versions of arbitrary packages and importing them is
 *    a supply-chain exposure, and a contract read from a running copy is not
 *    cheaper or truer than one read from the bytes.
 *
 * What that costs: a descriptor assembled at runtime cannot be read. Every such
 * gap becomes a note, and a surface with notes is `partial` — which stops later
 * layers from turning our blind spot into the package's missing guidance.
 */

/** Key names under which the ecosystems put a tool's JSON Schema. */
const SCHEMA_KEYS = ["inputSchema", "input_schema", "parameters", "schema"] as const;

export type ModuleExtractOptions = {
  package: string;
  version: string;
  source: PackageSource;
  ecosystem?: Ecosystem;
  /** Which door this is. Recorded on the contract; two doors never compare as one. */
  surface?: Surface;
  /** Subpath a consumer would import, e.g. "." or "./ai-sdk". */
  subpath?: string;
  condition?: EntryCondition;
  conditions?: readonly string[];
};

type DescriptorSite = {
  node: ObjectExpression;
  module: ParsedModule;
};

/** `pack.js:412`, or just the file when the parser gave no location. */
function evidenceAt(site: DescriptorSite): string {
  const line = site.node.loc?.start.line;
  return line === undefined ? site.module.path : `${site.module.path}:${line}`;
}

// --- AST scanning -----------------------------------------------------------

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Iterative walk. Dist files run to tens of thousands of lines, and a recursive
 * walk over one is a stack overflow waiting to happen during a backfill.
 */
function walk(root: AnyNode, visit: (node: AnyNode) => void): void {
  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    visit(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item);
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
}

/** Static key of a property, without evaluating anything. */
function staticKey(property: Property): string | null {
  if (property.kind !== "init" || property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
  return null;
}

function propertyMap(node: ObjectExpression): Map<string, Expression> {
  const out = new Map<string, Expression>();
  for (const property of node.properties) {
    if (property.type !== "Property") continue;
    const key = staticKey(property);
    if (key !== null) out.set(key, property.value as Expression);
  }
  return out;
}

/**
 * A tool descriptor is an object carrying a name and an argument schema.
 *
 * Deliberately shape-based rather than name-based: the same shape is what MCP,
 * the Anthropic API and every host pack put on the wire, so one rule covers all
 * of them and no per-vendor branch is ever needed.
 */
function isDescriptor(node: AnyNode): node is ObjectExpression {
  if (node.type !== "ObjectExpression") return false;
  const keys = propertyMap(node);
  if (!keys.has("name")) return false;
  return SCHEMA_KEYS.some((key) => keys.has(key));
}

function descriptorSites(modules: readonly ParsedModule[]): DescriptorSite[] {
  const sites: DescriptorSite[] = [];
  for (const module of modules) {
    const found: DescriptorSite[] = [];
    walk(module.program as AnyNode, (node) => {
      if (isDescriptor(node)) found.push({ node, module });
    });
    // The walk is a stack, so it finds them out of order. Source order is what
    // makes "the first declaration wins" a rule rather than an accident.
    found.sort((a, b) => a.node.start - b.node.start);
    sites.push(...found);
  }
  return sites;
}

// --- Descriptor -> tool -----------------------------------------------------

type ReadDescriptor = { tool: Tool; notes: ExtractionNote[] } | { tool: null; notes: ExtractionNote[] };

function readDescriptor(site: DescriptorSite, graph: ModuleGraph): ReadDescriptor {
  const properties = propertyMap(site.node);
  const resolve = graph.resolverFor(site.module);
  const evidence = evidenceAt(site);
  const notes: ExtractionNote[] = [];

  const nameNode = properties.get("name");
  const name = nameNode === undefined ? undefined : evaluate(nameNode as AnyNode, resolve).value;
  if (typeof name !== "string" || name.length === 0) {
    // Without a name there is no tool to report, and no way to say which one is
    // missing. It still has to be recorded: it means the tool set may be larger
    // than what we return, which makes every added/removed claim unsafe.
    return {
      tool: null,
      notes: [
        {
          code: "descriptor_name_unresolved",
          scope: "surface",
          target: null,
          evidence,
          detail: `the descriptor at ${evidence} names its tool with an expression that cannot be read statically`,
        },
      ],
    };
  }

  const descriptionNode = properties.get("description");
  let description: unknown = null;
  if (descriptionNode !== undefined) {
    description = evaluate(descriptionNode as AnyNode, resolve).value;
    if (typeof description !== "string") {
      // The difference that matters most in the whole product: a description we
      // could not read must never be reported as a description the package does
      // not ship.
      notes.push({
        code: "description_unresolved",
        scope: "description",
        target: name,
        evidence,
        detail: `\`${name}\` has a description this extractor could not read; absence here is our gap, not the package's`,
      });
      description = null;
    }
  }

  const schemaKey = SCHEMA_KEYS.find((key) => properties.has(key));
  const schemaNode = schemaKey === undefined ? undefined : properties.get(schemaKey);
  const schema = schemaNode === undefined ? undefined : evaluate(schemaNode as AnyNode, resolve);

  if (schema === undefined || isUnresolved(schema.value)) {
    notes.push({
      code: "descriptor_schema_unresolved",
      scope: "schema",
      target: name,
      evidence,
      detail: `\`${name}\` builds its argument schema at runtime; its parameters were not read`,
    });
    return { tool: { name, description: typeof description === "string" ? description : null, params: [] }, notes };
  }

  for (const path of schema.unresolved) {
    // A gap anywhere inside the schema can hide a parameter or its guidance.
    const isProse = path.endsWith("description");
    notes.push({
      code: isProse ? "description_unresolved" : "descriptor_schema_unresolved",
      scope: isProse ? "description" : "schema",
      target: `${name}.${path}`,
      evidence,
      detail: `\`${name}\` schema path \`${path}\` could not be read statically`,
    });
  }

  const tool = toolFrom(name, description, schema.value);
  return { tool, notes };
}

// --- Entry point ------------------------------------------------------------

const ABSENCE_DETAIL: Record<SurfaceAbsenceReason, string> = {
  no_package_json: "the package ships no readable package.json",
  not_exported: "the package does not export this entry point at this version",
  file_missing: "the package points at an entry file it did not ship",
  unparseable: "the entry file is not parseable as JavaScript",
  no_descriptors: "the entry file holds no tool descriptor",
  descriptors_unreadable: "the entry file holds tool descriptors whose names are built at runtime",
};

export function extractFromModule(options: ModuleExtractOptions): SurfaceResult {
  const {
    package: pkg,
    version,
    source,
    ecosystem = "npm",
    surface = "host-pack",
    subpath = ".",
    condition = "import",
    conditions,
  } = options;

  const absent = (reason: SurfaceAbsenceReason, checked: string[]): SurfaceResult => ({
    present: false,
    absence: { ecosystem, package: pkg, version, surface, reason, detail: ABSENCE_DETAIL[reason], checked },
  });

  const query = { subpath, condition, ...(conditions ? { conditions } : {}) };
  const entry = resolveEntryPoint(source, query);
  if (!entry.found) return absent(entry.reason, entry.candidates.length > 0 ? entry.candidates : [subpath]);

  const graph = new ModuleGraph(query);
  const entryModule = graph.load(source, entry.path);
  if (entryModule === null) return absent("unparseable", [entry.path]);

  const modules = graph.surfaceModules(entryModule);
  const sites = descriptorSites(modules);

  const notes: ExtractionNote[] = [];
  const byName = new Map<string, Tool>();

  for (const site of sites) {
    const read = readDescriptor(site, graph);
    notes.push(...read.notes);
    if (read.tool === null) continue;

    const existing = byName.get(read.tool.name);
    if (existing === undefined) {
      byName.set(read.tool.name, read.tool);
      continue;
    }
    // Two literals for one tool name in the same surface. The first wins, but a
    // silent choice here would be a fabricated contract, so it is recorded.
    if (JSON.stringify(existing) !== JSON.stringify(read.tool)) {
      notes.push({
        code: "duplicate_descriptor",
        scope: "schema",
        target: read.tool.name,
        evidence: evidenceAt(site),
        detail: `\`${read.tool.name}\` is declared more than once in this surface with different contents; the first was kept`,
      });
    }
  }

  if (byName.size === 0) {
    // Finding descriptors and failing to name them is not the same as finding
    // none. The first is our blind spot and must not be reported as the
    // package having no surface here.
    const checked = sites.length > 0 ? sites.map(evidenceAt) : modules.map((m) => m.path);
    return absent(sites.length > 0 ? "descriptors_unreadable" : "no_descriptors", checked);
  }

  const contract: Contract = {
    ecosystem,
    package: pkg,
    version,
    surface,
    extractedAt: new Date().toISOString(),
    extractorVersion: EXTRACTOR_VERSION,
    // Sorted so two versions compare without a diff caused by declaration order.
    tools: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };

  return { present: true, contract, fidelity: fidelityOf(notes), notes };
}
