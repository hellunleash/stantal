import { describe, expect, test } from "vitest";
import type { ExtractionNote, SurfaceAbsenceReason, SurfaceResult } from "../contract/surface.js";
import { EXTRACTOR_VERSION, type Contract, type Tool } from "../contract/types.js";
import { diffSurfaces } from "./surface.js";

function tool(name: string, params: Tool["params"] = []): Tool {
  return { name, description: `The ${name} tool.`, params };
}

function contract(version: string, tools: Tool[], surface: Contract["surface"] = "host-pack"): Contract {
  return {
    ecosystem: "npm",
    package: "@example/tools",
    version,
    surface,
    extractedAt: "2026-01-01T00:00:00.000Z",
    extractorVersion: EXTRACTOR_VERSION,
    tools,
  };
}

function present(version: string, tools: Tool[], notes: ExtractionNote[] = [], surface?: Contract["surface"]): SurfaceResult {
  return {
    present: true,
    contract: contract(version, tools, surface),
    fidelity: notes.length === 0 ? "complete" : "partial",
    notes,
  };
}

function absent(version: string, reason: SurfaceAbsenceReason): SurfaceResult {
  return {
    present: false,
    absence: {
      ecosystem: "npm",
      package: "@example/tools",
      version,
      surface: "host-pack",
      reason,
      detail: "test",
      checked: [],
    },
  };
}

const STRING_PARAM = {
  name: "target",
  type: "string" as const,
  required: true,
  description: null,
  constraints: {},
};

describe("diffSurfaces, presence", () => {
  test("compares two versions that both have the surface", () => {
    const comparison = diffSurfaces(present("1.0.0", [tool("build")]), present("2.0.0", [tool("build"), tool("open")]));
    expect(comparison.kind).toBe("compared");
    expect(comparison.diff?.changes.map((c) => c.rule)).toEqual(["tool_added"]);
  });

  test("a surface that did not exist before is not a pile of added tools", () => {
    const comparison = diffSurfaces(absent("1.0.0", "not_exported"), present("2.0.0", [tool("build"), tool("open")]));
    expect(comparison.kind).toBe("surface_introduced");
    // A structural diff here would say "2 tools added" about a contract that
    // had no earlier version to be added to.
    expect(comparison.diff).toBeNull();
    expect(comparison.breaking).toBe(false);
  });

  test("a surface that disappeared is breaking", () => {
    const comparison = diffSurfaces(present("1.0.0", [tool("build")]), absent("2.0.0", "not_exported"));
    expect(comparison.kind).toBe("surface_withdrawn");
    // The consumer's import stops resolving. Nothing subtler needs saying.
    expect(comparison.breaking).toBe(true);
  });

  test("neither version having the surface is a quiet answer", () => {
    const comparison = diffSurfaces(absent("1.0.0", "not_exported"), absent("2.0.0", "not_exported"));
    expect(comparison.kind).toBe("surface_absent");
    expect(comparison.breaking).toBe(false);
  });

  test("a failure to read is never reported as a withdrawal", () => {
    const comparison = diffSurfaces(present("1.0.0", [tool("build")]), absent("2.0.0", "descriptors_unreadable"));
    expect(comparison.kind).toBe("not_comparable");
    expect(comparison.breaking).toBe(false);
    expect(comparison.degraded).toBe(true);
  });

  test("an unparseable side is a reading gap, not a finding", () => {
    const comparison = diffSurfaces(absent("1.0.0", "unparseable"), present("2.0.0", [tool("build")]));
    expect(comparison.kind).toBe("not_comparable");
  });
});

describe("diffSurfaces, subject", () => {
  test("refuses to compare two different doors", () => {
    const comparison = diffSurfaces(
      present("2.0.0", [tool("build")], [], "mcp-server"),
      present("2.0.0", [tool("build"), tool("open")], [], "host-pack"),
    );
    // Two surfaces of one version disagreeing is a real finding, but it is not
    // a version delta and must not be reported as one.
    expect(comparison.kind).toBe("not_comparable");
    expect(comparison.diff).toBeNull();
  });
});

describe("diffSurfaces, extraction gaps", () => {
  const nameGap: ExtractionNote = {
    code: "descriptor_name_unresolved",
    scope: "surface",
    target: null,
    evidence: "pack.js:12",
    detail: "test",
  };
  const schemaGap: ExtractionNote = {
    code: "descriptor_schema_unresolved",
    scope: "schema",
    target: "build",
    evidence: "pack.js:20",
    detail: "test",
  };

  test("withholds added/removed tools when the tool set may be incomplete", () => {
    const comparison = diffSurfaces(present("1.0.0", [tool("build")], [nameGap]), present("2.0.0", [tool("build"), tool("open")]));
    expect(comparison.diff?.changes).toEqual([]);
    expect(comparison.suppressed.map((c) => c.rule)).toEqual(["tool_added"]);
    expect(comparison.degraded).toBe(true);
  });

  test("withholds parameter changes for a tool whose schema could not be read", () => {
    const comparison = diffSurfaces(
      present("1.0.0", [tool("build", [STRING_PARAM])], [schemaGap]),
      present("2.0.0", [tool("build")]),
    );
    // The empty parameter list is our blind spot. Reported plainly it would say
    // the package removed a required parameter.
    expect(comparison.diff?.changes).toEqual([]);
    expect(comparison.suppressed.map((c) => c.rule)).toEqual(["param_removed"]);
    expect(comparison.breaking).toBe(false);
  });

  test("keeps changes on tools the gap does not touch", () => {
    const comparison = diffSurfaces(
      present("1.0.0", [tool("build", [STRING_PARAM]), tool("open", [STRING_PARAM])], [schemaGap]),
      present("2.0.0", [tool("build", [STRING_PARAM]), tool("open")]),
    );
    expect(comparison.diff?.changes.map((c) => c.tool)).toEqual(["open"]);
    expect(comparison.breaking).toBe(true);
  });

  test("a clean comparison is not marked degraded", () => {
    const comparison = diffSurfaces(present("1.0.0", [tool("build")]), present("2.0.0", [tool("build")]));
    expect(comparison.degraded).toBe(false);
    expect(comparison.suppressed).toEqual([]);
  });
});
