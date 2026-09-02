import { describe, expect, test } from "vitest";
import { extractFromModule } from "./module.js";
import { memoryPackageSource, type PackageSource } from "./package-source.js";
import { isEvidencedAbsence } from "../contract/surface.js";

/**
 * Fixtures here are generic, hand-written packages written to exercise one
 * extraction behaviour each. They are examples, not evidence: nothing in this
 * file stands in for a real package or supports a claim about one.
 */

function packageOf(files: Record<string, string>, dependencies: Record<string, PackageSource> = {}) {
  return memoryPackageSource(files, dependencies);
}

const MANIFEST = JSON.stringify({
  name: "@example/tools",
  version: "2.0.0",
  exports: { ".": "./dist/index.js", "./pack": "./dist/pack.js" },
});

const PACK = `
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
export const tools = [
  {
    name: "build",
    description: "Build a screen from a plain-language request. Pass \\\`slot\\\` only when the request names a place for it to land.",
    inputSchema: {
      $schema: DRAFT,
      type: "object",
      properties: {
        request: { type: "string", minLength: 1, description: "What to build." },
        slot: { type: "string", minLength: 1 },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
  {
    name: "open",
    description: "Open an existing screen.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", minLength: 1 } },
      required: ["target"],
    },
  },
];
`;

function extract(files: Record<string, string>, options: Record<string, unknown> = {}) {
  return extractFromModule({
    package: "@example/tools",
    version: "2.0.0",
    source: packageOf({ "package.json": MANIFEST, ...files }),
    subpath: "./pack",
    ...options,
  });
}

describe("extractFromModule", () => {
  test("reads the descriptors out of the entry point", () => {
    const result = extract({ "dist/pack.js": PACK });
    expect(result.present).toBe(true);
    if (!result.present) return;

    expect(result.contract.tools.map((t) => t.name)).toEqual(["build", "open"]);
    expect(result.contract.surface).toBe("host-pack");
    expect(result.fidelity).toBe("complete");
    expect(result.notes).toEqual([]);
  });

  test("records an optional parameter that ships no description", () => {
    const result = extract({ "dist/pack.js": PACK });
    if (!result.present) throw new Error("expected a contract");

    const build = result.contract.tools.find((t) => t.name === "build");
    const slot = build?.params.find((p) => p.name === "slot");
    // The whole point of the normalized contract: an optional parameter with no
    // guidance is a recorded fact, not a missing field.
    expect(slot).toMatchObject({ required: false, description: null });
    expect(build?.params.find((p) => p.name === "request")?.description).toBe("What to build.");
  });

  test("sorts tools so declaration order never shows up as a diff", () => {
    const reversed = PACK.replace(/name: "build"/, "name: \"zzz\"");
    const result = extract({ "dist/pack.js": reversed });
    if (!result.present) throw new Error("expected a contract");
    expect(result.contract.tools.map((t) => t.name)).toEqual(["open", "zzz"]);
  });

  test("resolves a tool name imported from a dependency", () => {
    const core = packageOf({
      "package.json": JSON.stringify({ name: "@example/core", exports: { ".": "./index.js" } }),
      "index.js": `export const BUILD_TOOL = "build";`,
    });
    const result = extractFromModule({
      package: "@example/tools",
      version: "2.0.0",
      subpath: "./pack",
      source: memoryPackageSource(
        {
          "package.json": MANIFEST,
          "dist/pack.js": `
            import { BUILD_TOOL } from "@example/core";
            export const tools = [{ name: BUILD_TOOL, description: "Build.", inputSchema: { type: "object", properties: {} } }];
          `,
        },
        { "@example/core": core },
      ),
    });

    if (!result.present) throw new Error("expected a contract");
    // Shipped packs name tools with shared constants. A reader that stops at the
    // entry file reports a surface whose tools it cannot name.
    expect(result.contract.tools.map((t) => t.name)).toEqual(["build"]);
    expect(result.fidelity).toBe("complete");
  });

  test("finds a constant through an `export * from` barrel", () => {
    const core = packageOf({
      "package.json": JSON.stringify({ name: "@example/core", exports: { ".": "./index.js" } }),
      // The normal shape of a constants package: an index that re-exports
      // everything, with the value one file further in.
      "index.js": `export * from "./tools.js";\nexport * from "./other.js";`,
      "tools.js": `export const BUILD_TOOL = "build";`,
      "other.js": `export const UNRELATED = 1;`,
    });
    const result = extractFromModule({
      package: "@example/tools",
      version: "2.0.0",
      subpath: "./pack",
      source: memoryPackageSource(
        {
          "package.json": MANIFEST,
          "dist/pack.js": `
            import { BUILD_TOOL } from "@example/core";
            export const tools = [{ name: BUILD_TOOL, description: "Build.", inputSchema: { type: "object", properties: {} } }];
          `,
        },
        { "@example/core": core },
      ),
    });

    if (!result.present) throw new Error(`expected a contract, got ${result.absence.reason}`);
    expect(result.contract.tools.map((t) => t.name)).toEqual(["build"]);
  });

  test("follows a shim that imports the pack instead of re-exporting it", () => {
    // A published entry point is often a format shim: it imports the pack and
    // adapts it. The descriptors still belong to this door.
    const result = extract({
      "dist/pack.js": `export function build() {}\n${PACK}`,
      "dist/shim.js": `import { tools } from "./pack.js";\nexport const toolSet = tools;`,
    });
    expect(result.present).toBe(true);
  });

  test("does not pull descriptors in from a plain import of another package", () => {
    const other = packageOf({
      "package.json": JSON.stringify({ name: "@example/other", exports: { ".": "./index.js" } }),
      "index.js": `export const tools = [{ name: "somebody_elses_tool", description: "x", inputSchema: { type: "object", properties: {} } }];`,
    });
    const result = extractFromModule({
      package: "@example/tools",
      version: "2.0.0",
      subpath: "./pack",
      source: memoryPackageSource(
        {
          "package.json": MANIFEST,
          "dist/pack.js": `import { helper } from "@example/other";\n${PACK}`,
        },
        { "@example/other": other },
      ),
    });

    if (!result.present) throw new Error("expected a contract");
    // Merging a dependency's door into this one would destroy the divergence
    // between surfaces, which is the finding this project exists to make.
    expect(result.contract.tools.map((t) => t.name)).toEqual(["build", "open"]);
  });

  test("reads descriptors through a barrel entry point", () => {
    const result = extract({
      "dist/pack.js": `export * from "./descriptors.js";`,
      "dist/descriptors.js": PACK,
    });
    if (!result.present) throw new Error("expected a contract");
    expect(result.contract.tools.map((t) => t.name)).toEqual(["build", "open"]);
  });

  test("flags a description it could not read rather than calling it absent", () => {
    const result = extract({
      "dist/pack.js": `
        export const tools = [{ name: "build", description: loadText(), inputSchema: { type: "object", properties: {} } }];
      `,
    });
    if (!result.present) throw new Error("expected a contract");

    expect(result.fidelity).toBe("partial");
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({ code: "description_unresolved", scope: "description", target: "build" });
    // Without the note, this null would read as "the package ships no guidance".
    expect(result.contract.tools[0]?.description).toBeNull();
  });

  test("flags a schema built at runtime and reports no parameters for it", () => {
    const result = extract({
      "dist/pack.js": `
        export const tools = [{ name: "build", description: "Build.", parameters: zodToJsonSchema(shape) }];
      `,
    });
    if (!result.present) throw new Error("expected a contract");
    expect(result.notes[0]).toMatchObject({ code: "descriptor_schema_unresolved", scope: "schema", target: "build" });
    expect(result.contract.tools[0]?.params).toEqual([]);
  });

  test("carries a checkable line on every note", () => {
    const result = extract({
      "dist/pack.js": `\nexport const tools = [\n  { name: "build", description: loadText(), inputSchema: { type: "object", properties: {} } },\n];\n`,
    });
    if (!result.present) throw new Error("expected a contract");
    expect(result.notes[0]?.evidence).toBe("dist/pack.js:3");
  });

  test("does not run the package", () => {
    // If extraction imported this module, the throw would surface as a failure.
    const result = extract({
      "dist/pack.js": `
        throw new Error("this module must never be executed");
        export const tools = [{ name: "build", description: "Build.", inputSchema: { type: "object", properties: {} } }];
      `,
    });
    if (!result.present) throw new Error("expected a contract");
    expect(result.contract.tools.map((t) => t.name)).toEqual(["build"]);
  });
});

describe("extractFromModule, when the surface is not there", () => {
  test("a version that does not export this door has no contract", () => {
    const result = extractFromModule({
      package: "@example/tools",
      version: "1.0.0",
      subpath: "./pack",
      source: packageOf({
        "package.json": JSON.stringify({ name: "@example/tools", exports: { ".": "./dist/index.js" } }),
        "dist/index.js": "export const a = 1;",
      }),
    });

    expect(result.present).toBe(false);
    if (result.present) return;
    // Not an empty contract. An empty contract compares as "every tool removed".
    expect(result.absence.reason).toBe("not_exported");
  });

  test("an entry with no descriptors is absent, not an empty contract", () => {
    const result = extract({ "dist/pack.js": "export const version = 2;" });
    expect(result).toMatchObject({ present: false, absence: { reason: "no_descriptors" } });
  });

  test("descriptors it cannot name are reported apart from having none", () => {
    const result = extract({
      "dist/pack.js": `
        export const tools = [{ name: names.build, description: "Build.", inputSchema: { type: "object", properties: {} } }];
      `,
    });
    expect(result).toMatchObject({ present: false, absence: { reason: "descriptors_unreadable" } });
    if (result.present) return;
    // "We could not read it" and "it is not there" are different claims, and
    // only one of them is evidence about the package.
    expect(result.absence.checked[0]).toMatch(/dist\/pack\.js:\d+/);
  });

  test("an unparseable entry is a reading failure, not a finding", () => {
    const result = extract({ "dist/pack.js": "export const = ;;;" });
    expect(result).toMatchObject({ present: false, absence: { reason: "unparseable" } });
  });
});

describe("a JSON entry point", () => {
  test("is an evidenced absence, not a failed read", () => {
    // Packages very commonly export "./package.json". A manifest genuinely
    // holds no tool descriptors, so that is a fact about the file rather than a
    // gap in our reading. Reported as unparseable it becomes a withheld claim,
    // and one such door was enough to turn a whole comparison into
    // "unreadable" — found by running this tool against its own releases.
    const result = extractFromModule({
      package: "@example/tools",
      version: "2.0.0",
      subpath: "./package.json",
      source: packageOf({
        "package.json": JSON.stringify({
          name: "@example/tools",
          version: "2.0.0",
          exports: { ".": "./dist/index.js", "./package.json": "./package.json" },
        }),
        "dist/index.js": "export const x = 1;",
      }),
    });

    expect(result.present).toBe(false);
    if (result.present) return;
    expect(result.absence.reason).toBe("no_descriptors");
    expect(isEvidencedAbsence(result.absence.reason)).toBe(true);
  });
});

describe("what is a declaration, and what only looks like one", () => {
  test("reads a tool declared through a bare wrapper helper", () => {
    // `defineTool({...})` is called on nothing — the declaration is its
    // argument, and the wrapper only reshapes it at runtime.
    const result = extract({
      "dist/pack.js": `
        import { defineTool } from "@example/core";
        export const build = defineTool({
          name: "build",
          description: "Build a screen from a request.",
          input: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
        });
      `,
    });

    if (!result.present) throw new Error(`expected a contract, got ${result.absence.reason}`);
    expect(result.contract.tools.map((t) => t.name)).toEqual(["build"]);
  });

  test("does not read the wrapper's own return statement as a tool", () => {
    // The helper builds a descriptor out of whatever it is handed. Reading it
    // as a declaration produced an unresolvable name and reported the whole
    // surface as unreadable, so a package that declares its tools perfectly
    // legibly at the call sites looked like one that builds them dynamically.
    const result = extract({
      "dist/pack.js": `
        export function defineTool(tool) {
          return { name: tool.name, description: tool.description, inputSchema: tool.input };
        }
      `,
    });

    expect(result.present).toBe(false);
    if (result.present) return;
    // Nothing tool-shaped was declared here, and nothing claims otherwise.
    expect(result.absence.reason).toBe("no_descriptors");
  });

  test("does not read a renderer that rebuilds a descriptor from a past call", () => {
    const result = extract({
      "dist/pack.js": `
        export function buildApprovalRequest(part, tools) {
          return { name: part.tool, description: tools[part.tool].description, inputSchema: {} };
        }
      `,
    });

    expect(result.present).toBe(false);
    if (result.present) return;
    expect(result.absence.reason).toBe("no_descriptors");
  });

  test("does not read a zod schema describing descriptors as a descriptor", () => {
    // A schema for tools is descriptor-shaped and is a type, not an instance.
    // Its `name` is `z.string()`, which folds to nothing.
    const result = extract({
      "dist/pack.js": `
        import { z } from "zod";
        export const toolDescriptorSchema = z.object({
          name: z.string(),
          description: z.string(),
          inputSchema: z.unknown(),
        });
      `,
    });

    expect(result.present).toBe(false);
    if (result.present) return;
    expect(result.absence.reason).toBe("no_descriptors");
  });

  test("a file that imports a tool helper and yields nothing is a gap, not an empty surface", () => {
    // The shape here declares tools as a record keyed by tool name, which is
    // not descriptor-shaped at all — so there are no candidates to decline and
    // nothing to notice. The import is the package saying, in its own source,
    // that this file is about declaring tools. Without this, a server with a
    // dozen tools reports as shipping none.
    const result = extract({
      "dist/pack.js": `
        import { tool as makeTool } from "@example/mcp-utils";
        export function tools({ client }) {
          return { search_docs: makeTool({ description: async () => await client.schema() }) };
        }
      `,
    });

    expect(result.present).toBe(false);
    if (result.present) return;
    expect(result.absence.reason).toBe("descriptors_unreadable");
    expect(isEvidencedAbsence(result.absence.reason)).toBe(false);
    expect(result.absence.checked[0]).toContain("imports `tool`");
  });
});

describe("tools declared as a class", () => {
  test("assembles the name, description and schema from three places", () => {
    // The name is a static assignment after the class, the rest is set on
    // `this` in the constructor, and the base class registers every subclass
    // with `registerTool(this.name, ...)` — a call whose name can never fold.
    const result = extract({
      "dist/pack.js": `
        import { z } from "zod";
        export class ListDatabasesTool extends ToolBase {
          constructor() {
            super(...arguments);
            this.description = "List all databases for a connection";
            this.argsShape = { connectionId: z.string().describe("Which connection") };
          }
        }
        ListDatabasesTool.toolName = "list-databases";
      `,
    });

    if (!result.present) throw new Error(`expected a contract, got ${result.absence.reason}`);
    expect(result.contract.tools.map((t) => t.name)).toEqual(["list-databases"]);
    expect(result.contract.tools[0]?.description).toBe("List all databases for a connection");
    expect(result.contract.tools[0]?.params.map((p) => p.name)).toEqual(["connectionId"]);
  });

  test("finds the name even though it is assigned after the class", () => {
    // The AST walk is a stack and visits children in reverse source order, so a
    // single pass reaches the static assignment before the class it names and
    // silently drops every tool name in the file.
    const result = extract({
      "dist/pack.js": `
        export class A extends ToolBase {
          constructor() { super(); this.description = "First"; this.argsShape = {}; }
        }
        export class B extends ToolBase {
          constructor() { super(); this.description = "Second"; this.argsShape = {}; }
        }
        A.toolName = "first";
        B.toolName = "second";
      `,
    });

    if (!result.present) throw new Error(`expected a contract, got ${result.absence.reason}`);
    expect(result.contract.tools.map((t) => t.name).sort()).toEqual(["first", "second"]);
  });

  test("a named, documented class with no argument schema is not a tool", () => {
    // `mongodb-mcp-server` ships an `exported-data` *resource* class shaped
    // exactly like this. Reading it gave a one-tool contract for a server with
    // fifty, which diffs as every other tool having been removed — worse than
    // admitting the surface could not be read.
    const result = extract({
      "dist/pack.js": `
        export class ExportedData extends ResourceBase {
          constructor() { super(); this.description = "Data files exported in this session"; }
        }
        ExportedData.toolName = "exported-data";
      `,
    });

    expect(result.present).toBe(false);
  });

  test("an Error subclass is not a tool", () => {
    // `this.name` is `Error.prototype.name`. Accepting it read zod's `$ZodError`
    // as a tool and turned an honest gap into a wrong contract.
    const result = extract({
      "dist/pack.js": `
        export class $ZodError extends Error {
          constructor(issues) { super(); this.name = "$ZodError"; this.issues = issues; this.schema = {}; }
        }
      `,
    });

    expect(result.present).toBe(false);
  });
});
