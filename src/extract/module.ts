import type { AnyNode, Expression, ObjectExpression, Property } from "acorn";
import { toolFrom } from "../contract/from-json-schema.js";
import {
  fidelityOf,
  type ExtractionNote,
  type SurfaceAbsenceReason,
  type SurfaceResult,
} from "../contract/surface.js";
import {
  EXTRACTOR_VERSION,
  type Contract,
  type Ecosystem,
  type Param,
  type Surface,
  type Tool,
} from "../contract/types.js";
import { evaluate, isUnresolved } from "./js-literal.js";
import { ModuleGraph, type ParsedModule } from "./module-bindings.js";
import { resolveEntryPoint, type EntryCondition, type PackageSource } from "./package-source.js";
import { looksLikeZod, readZodSchema, zodNamespaces, type ZodContext } from "./zod-schema.js";

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
const SCHEMA_KEYS = ["inputSchema", "input_schema", "parameters", "schema", "input"] as const;

/**
 * The keys a *bare* object literal must carry to count as a descriptor.
 *
 * `input` is deliberately absent. It is a real schema key — `defineTool` uses
 * it — but only where a registration call vouches for the object. On its own,
 * `{ name, input }` describes a form field as readily as a tool.
 */
const LITERAL_SCHEMA_KEYS = SCHEMA_KEYS.filter((key) => key !== "input");

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
  /**
   * Set when the tool's name is a sibling argument rather than a key in the
   * descriptor — `server.registerTool(name, config, handler)`. The object alone
   * does not say what it is called.
   */
  nameNode?: Expression;
  /** Set when the description is a bare argument, as in the older `tool()` signature. */
  descriptionNode?: Expression;
  /**
   * Set when the schema *is* an argument rather than a key inside a descriptor.
   *
   * `server.tool(name, description, schema, ...)` passes the shape directly.
   * Searching that object for an `inputSchema` key finds nothing, and the tool
   * gets reported as taking no parameters — a false claim about a real API.
   */
  schemaNode?: Expression;
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
  // The stricter set on purpose. A bare object literal has no registration call
  // vouching for it, and `{ name, input }` is an ordinary shape for things that
  // are not tools at all — a form field, a test case, a CLI argument.
  return LITERAL_SCHEMA_KEYS.some((key) => keys.has(key));
}

/**
 * Registration calls that name a tool and describe it in separate arguments.
 *
 * The whole `McpServer` family registers this way, so a reader that only
 * matches `{ name, inputSchema }` object literals misses every server built on
 * the official SDK — which is the largest population of packages whose tool
 * descriptions are the entire contract.
 */
const REGISTRATION_METHODS = new Set(["registerTool", "tool", "addTool", "defineTool"]);

function callSite(node: AnyNode, module: ParsedModule): DescriptorSite | null {
  if (node.type !== "CallExpression") return null;

  // `defineTool({ name, description, input })` — a wrapper helper, called bare
  // rather than on a server object. The declaration is its argument, exactly as
  // it is for `zodToJsonSchema(ArgsSchema)`; the wrapper only reshapes it at
  // runtime. Missing this made every `@vendoai/*` surface that uses the helper
  // read as unnameable descriptors — 7 of the 18 gaps in the coverage census.
  if (node.callee.type === "Identifier") {
    if (!REGISTRATION_METHODS.has(node.callee.name)) return null;
    const [only] = node.arguments;
    if (only === undefined || only.type !== "ObjectExpression") return null;
    const keys = propertyMap(only);
    // The object has to name itself and describe itself. A bare identifier is a
    // much weaker signal than a member call, so this is the strict end of it:
    // without both, it is some other function that happens to share a name.
    if (!keys.has("name")) return null;
    const describes = keys.has("description") || SCHEMA_KEYS.some((k) => keys.has(k));
    return describes ? { node: only, module } : null;
  }

  if (node.callee.type !== "MemberExpression" || node.callee.computed) return null;
  if (node.callee.property.type !== "Identifier") return null;
  if (!REGISTRATION_METHODS.has(node.callee.property.name)) return null;

  const [first, second, third] = node.arguments;
  if (first === undefined || first.type === "SpreadElement") return null;

  // `registerTool(name, { description, inputSchema }, handler)`
  if (second !== undefined && second.type === "ObjectExpression") {
    const keys = propertyMap(second);
    const describes = keys.has("description") || SCHEMA_KEYS.some((k) => keys.has(k));
    // `.tool()` is an ordinary method name elsewhere. Requiring the second
    // argument to actually describe a tool keeps this from matching everything.
    return describes ? { node: second, module, nameNode: first as Expression } : null;
  }

  // `tool(name, "description", schema, handler)` — the older signature, where
  // the descriptor is spread across arguments and there is no object at all.
  // The third argument is the schema itself, not a descriptor holding one.
  if (second !== undefined && third !== undefined && third.type === "ObjectExpression") {
    return {
      node: third,
      module,
      nameNode: first as Expression,
      descriptionNode: second as Expression,
      schemaNode: third as Expression,
    };
  }

  return null;
}

/** The identifier a member chain hangs off: `tool.name` -> `tool`, `this.name` -> null. */
function rootIdentifier(node: Expression | undefined): string | null {
  let current: AnyNode | undefined = node;
  while (current !== undefined) {
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression") {
      current = current.object as AnyNode;
      continue;
    }
    return null;
  }
  return null;
}

function isFunctionNode(node: AnyNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** Parameter names a function binds, for the simple shapes that matter here. */
function boundParameters(node: AnyNode): string[] {
  const params = (node as { params?: unknown }).params;
  if (!Array.isArray(params)) return [];
  const names: string[] = [];
  for (const param of params) {
    if (!isNode(param)) continue;
    if (param.type === "Identifier") names.push(param.name);
    else if (param.type === "AssignmentPattern" && param.left.type === "Identifier") names.push(param.left.name);
    else if (param.type === "RestElement" && param.argument.type === "Identifier") names.push(param.argument.name);
  }
  return names;
}

/**
 * Is this object a declaration, or a factory building one from its input?
 *
 * ```js
 * export function defineTool(tool) {
 *   return { name: tool.name, description: tool.description, inputSchema };
 * }
 * ```
 *
 * That is descriptor-shaped and is not a descriptor. It is the wrapper every
 * caller passes a real declaration to, and its `name` is whatever it is handed
 * at runtime. Reading it as a tool produced an unresolvable name and reported
 * the whole surface as unreadable — so a package that declares its tools
 * perfectly legibly at the call sites looked like one that builds them
 * dynamically.
 *
 * The same shape appears in renderers. `@vendoai/ui` builds
 * `{ name: part.tool, ... }` from a tool call that already happened; that
 * entry point renders contracts rather than declaring any, and calling it a
 * reading gap told a real user their most-used surface was unprotected when
 * there was nothing there to protect.
 *
 * The test is narrow on purpose: the name has to hang off a binding the
 * enclosing function itself takes as a parameter. `this.name` is not this —
 * that is a class instance property, a real declaration spread across a
 * hierarchy, and it stays an honest gap.
 */
function isFactory(site: DescriptorSite, params: ReadonlySet<string>): boolean {
  const nameNode = site.nameNode ?? propertyMap(site.node).get("name");
  if (nameNode === undefined) return false;
  const root = rootIdentifier(nameNode);
  return root !== null && params.has(root);
}

/** The walk, carrying the parameter names bound by each enclosing function. */
function walkScoped(root: AnyNode, visit: (node: AnyNode, params: ReadonlySet<string>) => void): void {
  const stack: Array<{ node: AnyNode; params: ReadonlySet<string> }> = [{ node: root, params: new Set() }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    const { node } = frame;
    visit(node, frame.params);

    let params = frame.params;
    if (isFunctionNode(node)) {
      const bound = boundParameters(node);
      if (bound.length > 0) params = new Set([...frame.params, ...bound]);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push({ node: item, params });
      } else if (isNode(value)) {
        stack.push({ node: value, params });
      }
    }
  }
}

/**
 * A file that imported a tool-registration helper, and where from.
 *
 * Matched on the **imported** name rather than the local one, so a bundler's
 * `import { tool as Ro }` still counts — the same reason the zod reader matches
 * a namespace by fingerprint instead of by the letter `z`.
 */
function registrationImport(modules: readonly ParsedModule[]): string | null {
  for (const module of modules) {
    for (const statement of module.program.body) {
      if (statement.type !== "ImportDeclaration") continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ImportSpecifier") continue;
        const imported =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : typeof specifier.imported.value === "string"
              ? specifier.imported.value
              : null;
        if (imported !== null && REGISTRATION_METHODS.has(imported)) {
          const from = typeof statement.source.value === "string" ? statement.source.value : "?";
          return `${module.path} imports \`${imported}\` from \`${from}\``;
        }
      }
    }
  }
  return null;
}

/** Zod calls whose argument is a shape, not a value. */
const ZOD_SHAPE_METHODS = new Set(["object", "strictObject", "looseObject", "interface"]);

/**
 * The object handed to `z.object(...)`, when this call is one.
 *
 * A schema *describing* descriptors is descriptor-shaped:
 *
 * ```js
 * export const toolDescriptorSchema = z.object({
 *   name: z.string().regex(TOOL_NAME_PATTERN),
 *   description: z.string(),
 *   inputSchema: jsonSchemaSchema,
 * });
 * ```
 *
 * Read as a tool, its name is `z.string().regex(...)`, which folds to nothing —
 * so a package that validates its own contract got reported as one whose
 * descriptors cannot be named. The shape is a type, not an instance.
 */
function zodShapeArgument(node: AnyNode, isNamespace: (name: string) => boolean): ObjectExpression | null {
  if (node.type !== "CallExpression") return null;
  if (node.callee.type !== "MemberExpression" || node.callee.computed) return null;
  if (node.callee.property.type !== "Identifier") return null;
  if (!ZOD_SHAPE_METHODS.has(node.callee.property.name)) return null;

  const root = rootIdentifier(node.callee.object as Expression);
  if (root === null || !isNamespace(root)) return null;

  const [only] = node.arguments;
  return only !== undefined && only.type === "ObjectExpression" ? only : null;
}

function descriptorSites(modules: readonly ParsedModule[]): DescriptorSite[] {
  const sites: DescriptorSite[] = [];
  for (const module of modules) {
    const found: DescriptorSite[] = [];
    const claimed = new Set<ObjectExpression>();
    const namespaces = namespacesFor(module);
    const isNamespace = (name: string): boolean => namespaces.has(name);

    walkScoped(module.program as AnyNode, (node, params) => {
      // Claimed before the descriptor branch can see it. The walk visits a
      // parent before its children, which is what makes claiming work at all.
      const shape = zodShapeArgument(node, isNamespace);
      if (shape !== null) claimed.add(shape);

      const call = callSite(node, module);
      if (call !== null) {
        claimed.add(call.node);
        if (!isFactory(call, params)) found.push(call);
        return;
      }
      // A config object already claimed by its registration call must not be
      // counted twice, once named and once anonymous.
      if (isDescriptor(node) && !claimed.has(node)) {
        const site: DescriptorSite = { node, module };
        if (!isFactory(site, params)) found.push(site);
      }
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

/**
 * A `ZodContext` backed by the module graph.
 *
 * The context travels with the node, because a schema constant imported from
 * another file resolves its own identifiers over there. Following that is the
 * difference between reading a package that defines its schemas in one file and
 * reading one that keeps them in a shared module — which is most of them.
 */
const NAMESPACES = new WeakMap<ParsedModule, Set<string>>();

/** Which identifiers act as the zod namespace here. Computed once per module. */
function namespacesFor(module: ParsedModule): Set<string> {
  let found = NAMESPACES.get(module);
  if (found === undefined) {
    found = zodNamespaces(module.program);
    NAMESPACES.set(module, found);
  }
  return found;
}

function zodContextFor(module: ParsedModule, graph: ModuleGraph): ZodContext {
  const resolve = graph.resolverFor(module);
  const namespaces = namespacesFor(module);
  return {
    // Accepts a dotted `ns.Name` as well as a plain one, so a schema behind a
    // namespace import resolves like any other.
    binding(name) {
      const found = graph.nodeFor(module, name);
      if (found === null) return null;
      return {
        node: found.node,
        context: found.module === module ? zodContextFor(module, graph) : zodContextFor(found.module, graph),
      };
    },
    value: (node) => evaluate(node, resolve).value,
    isNamespace: (name) => namespaces.has(name),
  };
}

/**
 * Read a descriptor's schema as zod, or say why it could not be.
 *
 * Returns null when the expression is not zod at all, so the caller falls back
 * to the gap it would have reported anyway. A refusal comes back as parameters
 * plus a note: the reading failed, and that fact suppresses claims downstream
 * rather than looking like a tool with no parameters.
 */
function readZodDescriptor(
  node: AnyNode,
  site: DescriptorSite,
  graph: ModuleGraph,
  name: string,
  evidence: string,
): { params: Param[]; notes: ExtractionNote[] } | null {
  const context = zodContextFor(site.module, graph);
  if (!looksLikeZod(node, context.isNamespace)) return null;

  const result = readZodSchema(node, context);
  if (result === null) return null;

  if ("refuse" in result) {
    return {
      params: [],
      notes: [
        {
          code: "descriptor_schema_unresolved",
          scope: "schema",
          target: name,
          evidence,
          detail: `\`${name}\` declares its parameters with zod, and ${result.refuse}`,
        },
      ],
    };
  }

  // A gap at the root means the parameter *set* is unknown, so it is recorded
  // against the tool. A gap at a path means only that path is unknown. The
  // difference decides how much the classifier has to withhold.
  const notes: ExtractionNote[] = result.gaps.map((gap) => ({
    code: "descriptor_schema_unresolved" as const,
    scope: "schema" as const,
    target: gap.path === "(root)" ? name : `${name}.${gap.path}`,
    evidence,
    detail: `\`${name}\`: ${gap.reason}`,
  }));

  // Zod that reads to nothing is a reading failure, not an empty contract. A
  // zero-parameter tool diffs as "every parameter removed".
  if (result.params.length === 0) {
    notes.push({
      code: "descriptor_schema_unresolved",
      scope: "schema",
      target: name,
      evidence,
      detail: `\`${name}\` declares its parameters with zod, but none of them could be read`,
    });
  }

  return { params: result.params, notes };
}

function readDescriptor(site: DescriptorSite, graph: ModuleGraph): ReadDescriptor {
  const properties = propertyMap(site.node);
  const resolve = graph.resolverFor(site.module);
  const evidence = evidenceAt(site);
  const notes: ExtractionNote[] = [];

  const nameNode = site.nameNode ?? properties.get("name");
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

  const descriptionNode = site.descriptionNode ?? properties.get("description");
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
  const schemaNode = site.schemaNode ?? (schemaKey === undefined ? undefined : properties.get(schemaKey));

  // Zod gets the first look, before the literal folder.
  //
  // This ordering is not a preference, it is a correctness fix. A zod raw shape
  // — `{ path: z.string() }` — folds to a *partial* object: every value drops
  // out and an empty `{}` survives. An empty object is not UNRESOLVED, so a
  // zod-last reader never even asks, and reports a tool that takes no
  // parameters. That is a false claim, and it diffs as every parameter removed.
  const asZod =
    schemaNode === undefined ? null : readZodDescriptor(schemaNode as AnyNode, site, graph, name, evidence);
  if (asZod !== null) {
    notes.push(...asZod.notes);
    return {
      tool: {
        name,
        description: typeof description === "string" ? description : null,
        params: asZod.params,
      },
      notes,
    };
  }

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

  // A JSON entry point is not a failed read. Packages very commonly export
  // "./package.json", and a manifest genuinely holds no tool descriptors — that
  // is a fact about the file rather than a gap in our reading, so it must be an
  // evidenced absence. Reported as unparseable it becomes a withheld claim, and
  // one such door was enough to turn a whole comparison into "unreadable".
  if (/.json$/i.test(entry.path)) return absent("no_descriptors", [entry.path]);

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
    if (sites.length > 0) {
      return absent("descriptors_unreadable", sites.map(evidenceAt));
    }

    // Nor is "we found none here" the same as "there are none", in a file that
    // imported a tool-registration helper in order to use it.
    //
    // `@supabase/mcp-server-supabase` is the case that proves it. It does
    // `import { tool } from "@supabase/mcp-utils"` and then returns
    // `{ search_docs: tool({...}) }` from a factory — a record keyed by tool
    // name, with an async description. Nothing in that shape is descriptor
    // shaped, so this reader sees no candidates at all and would otherwise
    // report a server with a dozen tools as shipping none. The import is the
    // package saying, in its own source, that this file is about declaring
    // tools.
    const helper = registrationImport(modules);
    if (helper !== null) {
      return absent("descriptors_unreadable", [helper]);
    }

    return absent("no_descriptors", modules.map((m) => m.path));
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
