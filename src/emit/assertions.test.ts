import { describe, expect, test } from "vitest";
import type { ExtractionNote, SurfaceResult } from "../contract/surface.js";
import { EXTRACTOR_VERSION, type Contract, type Param, type Tool } from "../contract/types.js";
import type { StructuralChange } from "../diff/structural.js";
import type { ProseFinding } from "../prose/taxonomy.js";
import type { Report, SurfaceReport } from "../report.js";
import { assertionsFromContract, assertionsFromReport, findParam, holds } from "./assertions.js";
import type { Assertion } from "./taxonomy.js";

function param(name: string, over: Partial<Param> = {}): Param {
  return { name, type: "string", required: false, description: null, constraints: {}, ...over };
}

function tool(name: string, params: Param[] = [], description: string | null = `The ${name} tool.`): Tool {
  return { name, description, params };
}

function contract(tools: Tool[], version = "1.4.0"): Contract {
  return {
    ecosystem: "npm",
    package: "@example/tools",
    version,
    surface: "host-pack",
    extractedAt: "2026-01-01T00:00:00.000Z",
    extractorVersion: EXTRACTOR_VERSION,
    tools,
  };
}

function present(tools: Tool[], notes: ExtractionNote[] = []): SurfaceResult {
  return { present: true, contract: contract(tools), fidelity: notes.length === 0 ? "complete" : "partial", notes };
}

function surfaceReport(over: {
  from: SurfaceResult;
  changes?: StructuralChange[];
  findings?: ProseFinding[];
  subpath?: string;
}): SurfaceReport {
  const changes = over.changes ?? [];
  return {
    subpath: over.subpath ?? "./pack",
    from: over.from,
    to: present([]),
    comparison: {
      kind: "compared",
      diff: { changes, breaking: changes.some((c) => c.breaking), changedTools: [...new Set(changes.map((c) => c.tool))] },
      breaking: false,
      degraded: false,
      suppressed: [],
      note: "",
    },
    prose: { findings: over.findings ?? [], skipped: [], judge: "none" },
    behaviour: null,
  };
}

function report(surfaces: SurfaceReport[]): Report {
  return {
    subject: { ecosystem: "npm", package: "@example/tools", from: "1.4.0", to: "1.5.0" },
    verdict: "prose-risk",
    headline: "",
    surfaces,
    missingDependencies: [],
    judge: "none",
    caller: "none",
    blast: null,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function change(over: Partial<StructuralChange> & Pick<StructuralChange, "rule" | "target" | "tool">): StructuralChange {
  return { breaking: true, note: "", ...over };
}

function finding(over: Partial<ProseFinding> & Pick<ProseFinding, "rule" | "target" | "tool">): ProseFinding {
  return {
    severity: "medium",
    basis: "deterministic",
    confidence: "certain",
    headline: "",
    evidence: { target: over.target, before: null, after: null, quote: null, location: null },
    ...over,
  };
}

describe("an emitted assertion pins the side the consumer depends on", () => {
  test("a removed tool becomes a test that it is still there", () => {
    // The finding says the tool is gone in 1.5.0. The test asserts it is
    // present, so it passes today and fails the moment the upgrade lands.
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build")]),
          changes: [change({ rule: "tool_removed", target: "build", tool: "build" })],
        }),
      ]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "tool_present", tool: "build", subpath: "./pack" });
  });

  test("a parameter that became required is pinned as still optional", () => {
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build", [param("target")])]),
          changes: [change({ rule: "param_became_required", target: "build.target", tool: "build" })],
        }),
      ]),
    );
    expect(result[0]).toMatchObject({ kind: "param_optional", tool: "build", param: "target" });
  });

  test("nothing is pinned for what the newer version merely added", () => {
    // Asserting the absence of a feature fails as soon as the consumer upgrades
    // on purpose, which is not a defect and not something to warn about.
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build")]),
          changes: [
            change({ rule: "tool_added", target: "deploy", tool: "deploy", breaking: false }),
            change({ rule: "param_added_optional", target: "build.mode", tool: "build", breaking: false }),
          ],
        }),
      ]),
    );
    expect(result).toEqual([]);
  });
});

describe("an assertion is verified before it is written", () => {
  test("a claim the contract does not support is dropped", () => {
    // The differ says `build.target` was removed, but the older contract has no
    // such parameter either. Emitting the test anyway would produce a file that
    // fails on a version where nothing is wrong.
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build")]),
          changes: [change({ rule: "param_removed", target: "build.target", tool: "build" })],
        }),
      ]),
    );
    expect(result).toEqual([]);
  });

  test("undocumented_optional is not pinned when the older side does not document it either", () => {
    // The single most important case in this file. `target` is undescribed on
    // both sides, so "still explains when to pass target" has never been true
    // and a generated test asserting it can never pass.
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build", [param("target")], "Builds the project.")]),
          findings: [finding({ rule: "undocumented_optional", target: "build.target", tool: "build" })],
        }),
      ]),
    );
    expect(result).toEqual([]);
  });

  test("undocumented_optional is pinned when the older side did document it", () => {
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([
            tool("build", [param("target")], "Builds the project. Pass `target` only when overriding the default."),
          ]),
          findings: [finding({ rule: "undocumented_optional", target: "build.target", tool: "build" })],
        }),
      ]),
    );
    expect(result[0]).toMatchObject({ kind: "param_documented", tool: "build", param: "target" });
  });

  test("a deleted sentence is only pinned when it is really in the older text", () => {
    const from = present([tool("build", [], "Builds the project. Pass `target` to override.")]);
    const real = assertionsFromReport(
      report([
        surfaceReport({
          from,
          findings: [
            finding({
              rule: "guidance_removed",
              target: "build",
              tool: "build",
              evidence: { target: "build", before: null, after: null, quote: "Pass `target` to override.", location: null },
            }),
          ],
        }),
      ]),
    );
    expect(real[0]).toMatchObject({ kind: "description_includes" });

    const invented = assertionsFromReport(
      report([
        surfaceReport({
          from,
          findings: [
            finding({
              rule: "guidance_removed",
              target: "build",
              tool: "build",
              evidence: { target: "build", before: null, after: null, quote: "A sentence that was never shipped.", location: null },
            }),
          ],
        }),
      ]),
    );
    expect(invented).toEqual([]);
  });
});

describe("gaps suppress assertions, exactly as they suppress claims", () => {
  test("a tool whose schema could not be read gets no parameter tests", () => {
    const notes: ExtractionNote[] = [
      { code: "descriptor_schema_unresolved", scope: "schema", target: "build", evidence: "pack.js:12", detail: "zod" },
    ];
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build", [param("target")])], notes),
          changes: [
            change({ rule: "param_removed", target: "build.target", tool: "build" }),
            change({ rule: "tool_removed", target: "build", tool: "build" }),
          ],
        }),
      ]),
    );
    // The tool itself is still pinnable — its name was read. Its parameters are not.
    expect(result.map((a) => a.kind)).toEqual(["tool_present"]);
  });

  test("a tool whose prose could not be read gets no description tests", () => {
    const notes: ExtractionNote[] = [
      { code: "description_unresolved", scope: "description", target: "build", evidence: "pack.js:9", detail: "imported" },
    ];
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build", [param("target")], "Pass `target` to override.")], notes),
          findings: [
            finding({
              rule: "guidance_removed",
              target: "build",
              tool: "build",
              evidence: { target: "build", before: null, after: null, quote: "Pass `target` to override.", location: null },
            }),
          ],
        }),
      ]),
    );
    expect(result).toEqual([]);
  });

  test("an unconfirmed prose finding never earns a test", () => {
    // The spec's delivery ladder: a rule matched a pattern and nothing checked
    // the meaning. That is a line in a report, never a file in someone's repo.
    const result = assertionsFromReport(
      report([
        surfaceReport({
          from: present([tool("build", [param("target")], "Pass `target` to override.")]),
          findings: [
            finding({ rule: "undocumented_optional", target: "build.target", tool: "build", confidence: "unconfirmed" }),
          ],
        }),
      ]),
    );
    expect(result).toEqual([]);
  });

  test("a surface that could not be read at all yields nothing", () => {
    const result = assertionsFromReport(
      report([
        {
          ...surfaceReport({ from: present([]) }),
          from: { present: false, absence: { ecosystem: "npm", package: "@example/tools", version: "1.4.0", surface: "host-pack", reason: "unparseable", detail: "", checked: [] } },
        },
      ]),
    );
    expect(result).toEqual([]);
  });
});

describe("pinning a whole contract", () => {
  test("records every tool and parameter, and their required-ness", () => {
    const result = assertionsFromContract(
      contract([tool("build", [param("target"), param("out", { required: true })])]),
      "./pack",
    );
    expect(result.map((a) => `${a.kind}:${a.tool}${a.param ? "." + a.param : ""}`)).toEqual([
      "tool_present:build",
      "param_present:build.target",
      "param_optional:build.target",
      "param_present:build.out",
      "param_required:build.out",
    ]);
  });

  test("says nothing about a tool whose schema could not be read", () => {
    const result = assertionsFromContract(
      contract([tool("build", [param("target")])]),
      "./pack",
      [{ code: "descriptor_schema_unresolved", scope: "schema", target: "build", evidence: null, detail: "" }],
    );
    expect(result.map((a) => a.kind)).toEqual(["tool_present"]);
  });
});

describe("lookups", () => {
  test("finds a parameter nested inside an object", () => {
    const c = contract([tool("build", [param("options", { type: "object", children: [param("limit", { type: "number" })] })])]);
    expect(findParam(c, "build", "options.limit")?.type).toBe("number");
    expect(findParam(c, "build", "options.missing")).toBeNull();
  });

  test("an assertion about a tool that is not there does not hold", () => {
    const a: Assertion = { kind: "tool_present", subpath: "./pack", tool: "ghost", why: "" };
    expect(holds(a, contract([tool("build")]))).toBe(false);
  });
});
