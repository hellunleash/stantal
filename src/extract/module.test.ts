import { describe, expect, test } from "vitest";
import { extractFromModule } from "./module.js";
import { memoryPackageSource, type PackageSource } from "./package-source.js";

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
