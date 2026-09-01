import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SurfaceResult } from "../contract/surface.js";
import { EXTRACTOR_VERSION, type Contract, type Tool } from "../contract/types.js";
import type { ProseFinding, ProseRule } from "../prose/taxonomy.js";
import type { Report, SurfaceReport } from "../report.js";
import { applyPatch, codeFiles, locate, planPatch } from "./plan.js";
import { canApply } from "./taxonomy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stantal-patch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relative: string, contents: string): void {
  const full = join(dir, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function tool(name: string, description: string | null): Tool {
  return { name, description, params: [] };
}

function contract(tools: Tool[], version: string): Contract {
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

function present(tools: Tool[], version: string): SurfaceResult {
  return { present: true, contract: contract(tools, version), fidelity: "complete", notes: [] };
}

function finding(
  tool: string,
  rule: ProseRule = "guidance_removed",
  confidence: ProseFinding["confidence"] = "certain",
): ProseFinding {
  return {
    rule,
    target: tool,
    tool,
    severity: "medium",
    basis: "deterministic",
    confidence,
    headline: "",
    evidence: { target: tool, before: null, after: null, quote: null, location: null },
  };
}

function report(before: Tool[], after: Tool[], findings: ProseFinding[]): Report {
  const surface: SurfaceReport = {
    subpath: "./pack",
    from: present(before, "1.4.0"),
    to: present(after, "1.5.0"),
    comparison: { kind: "compared", diff: null, breaking: false, degraded: false, suppressed: [], note: "" },
    prose: { findings, skipped: [], judge: "none" },
    behaviour: null,
  };
  return {
    subject: { ecosystem: "npm", package: "@example/tools", from: "1.4.0", to: "1.5.0" },
    verdict: "prose-risk",
    headline: "",
    surfaces: [surface],
    missingDependencies: [],
    judge: "none",
    caller: "none",
    blast: null,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const OLD = "Builds the project. Pass `target` only when overriding the default.";
const NEW = "Builds the project.";

describe("locating the text as shipped", () => {
  test("finds a plain description exactly once", () => {
    write("dist/pack.js", `export const tools = [{ name: "build", description: "${NEW}" }];`);
    const found = locate(NEW, dir, codeFiles(dir));
    expect(found).toMatchObject({ found: true, hits: [{ file: "dist/pack.js", encoding: "raw" }] });
  });

  test("refuses when the text appears twice", () => {
    // Which occurrence to edit would be a guess, and a guess that rewrites
    // someone's dependency is worse than doing nothing.
    write("dist/pack.js", `const a = "${NEW}"; const b = "${NEW}";`);
    expect(locate(NEW, dir, codeFiles(dir))).toMatchObject({ found: false, reason: "ambiguous" });
  });

  test("one hit each in several files is not a guess", () => {
    // MCP servers routinely ship the same bundle once per transport. Both are
    // contracts a consumer can load, so restoring one and not the other would
    // leave the package saying two different things. Refusing outright left
    // the most common shape of MCP package unpatchable.
    write("dist/stdio.js", `const d = "${NEW}";`);
    write("dist/http.js", `const d = "${NEW}";`);
    const found = locate(NEW, dir, codeFiles(dir));
    expect(found).toMatchObject({ found: true });
    if (!found.found) throw new Error("expected a hit");
    expect(found.hits.map((h) => h.file).sort()).toEqual(["dist/http.js", "dist/stdio.js"]);
  });

  test("refuses when the text is nowhere", () => {
    write("dist/pack.js", `export const tools = [];`);
    expect(locate(NEW, dir, codeFiles(dir))).toMatchObject({ found: false, reason: "not_found" });
  });

  test("finds a description whose literal is escaped", () => {
    // The contract reader returns the evaluated string. What is in the file is
    // a literal, and a multi-line one does not match the evaluated text byte
    // for byte. Searching only the raw form fails on exactly the long
    // descriptions most worth restoring.
    const text = 'Builds it.\nSay "yes" to continue.';
    write("dist/pack.js", `const d = ${JSON.stringify(text)};`);
    const found = locate(text, dir, codeFiles(dir));
    expect(found).toMatchObject({ found: true, hits: [{ encoding: "escaped" }] });
  });
});

describe("which files are searched", () => {
  test("a nested node_modules is left alone", () => {
    // It belongs to a different package. Editing it would patch a dependency
    // of the dependency without ever saying so.
    write("dist/pack.js", `const a = 1;`);
    write("node_modules/other/dist/pack.js", `const b = 2;`);
    expect(codeFiles(dir)).toEqual(["dist/pack.js"]);
  });

  test("type declarations and source maps are skipped", () => {
    // They carry copies of the same strings, which would turn one clean match
    // into an ambiguous one and refuse an edit that was fine.
    write("dist/pack.js", `const a = 1;`);
    write("dist/pack.d.ts", `declare const a: number;`);
    write("dist/pack.js.map", `{}`);
    expect(codeFiles(dir)).toEqual(["dist/pack.js"]);
  });
});

describe("planning a restoration", () => {
  test("plans an edit that puts the old description back", () => {
    write("dist/pack.js", `const d = "${NEW}";`);
    const plan = planPatch({
      report: report([tool("build", OLD)], [tool("build", NEW)], [finding("build")]),
      packageDir: dir,
    });

    expect(canApply(plan)).toBe(true);
    expect(plan.edits[0]).toMatchObject({ file: "dist/pack.js", find: NEW, replace: OLD, tool: "build" });
  });

  test("refuses a second time when the restoration is already in place", () => {
    // The deleted sentence is usually a *trailing* one, so the newer text is a
    // prefix of the older. Searching for it still finds it inside text that has
    // already been restored, and a second run would append the sentence twice.
    // Found by running it against exa-mcp-server 3.1.2 -> 3.1.3.
    const shorter = "Searches the web.";
    const longer = "Searches the web. Pass extra queries for better results.";
    write("dist/pack.js", `const d = "${longer}";`);

    const plan = planPatch({
      report: report([tool("build", longer)], [tool("build", shorter)], [finding("build")]),
      packageDir: dir,
    });

    expect(plan.edits).toEqual([]);
    expect(plan.refused[0]).toMatchObject({ tool: "build", reason: "unchanged" });
    expect(plan.refused[0]?.detail).toContain("already restored");
  });

  test("edits every copy of a bundle, not one of them", () => {
    // Both are contracts a consumer can load. Restoring one and not the other
    // would leave the package saying two different things.
    write("dist/stdio.js", `const d = "${NEW}";`);
    write("dist/http.js", `const d = "${NEW}";`);

    const plan = planPatch({
      report: report([tool("build", OLD)], [tool("build", NEW)], [finding("build")]),
      packageDir: dir,
    });

    expect(canApply(plan)).toBe(true);
    expect(plan.edits.map((e) => e.file).sort()).toEqual(["dist/http.js", "dist/stdio.js"]);
  });

  test("re-encodes the replacement to match what it replaces", () => {
    // Restoring raw text into an escaped literal ends the string early and
    // breaks the file the patch was meant to repair.
    const oldText = 'Compiles it.\nPass "target" to override.';
    const newText = "Compiles it.\nNothing else.";
    // Both carry a newline, so what sits in the file is the escaped literal
    // rather than the evaluated text.
    write("dist/pack.js", `const d = ${JSON.stringify(newText)};`);
    const plan = planPatch({
      report: report([tool("build", oldText)], [tool("build", newText)], [finding("build")]),
      packageDir: dir,
    });
    const edit = plan.edits[0];
    expect(edit?.replace).not.toContain("\n");
    expect(edit?.replace).toBe(JSON.stringify(oldText).slice(1, -1));
  });

  test("refuses an unconfirmed finding", () => {
    // A patch is the strongest thing this tool emits, so it needs the strongest
    // evidence. Editing a stranger's dependency on a pattern match is not it.
    write("dist/pack.js", `const d = "${NEW}";`);
    const plan = planPatch({
      report: report([tool("build", OLD)], [tool("build", NEW)], [finding("build", "guidance_removed", "unconfirmed")]),
      packageDir: dir,
    });
    expect(plan.edits).toEqual([]);
    expect(plan.refused[0]).toMatchObject({ reason: "not_certain", tool: "build" });
  });

  test("refuses when either side ships no description", () => {
    write("dist/pack.js", `const d = "${NEW}";`);
    const plan = planPatch({
      report: report([tool("build", null)], [tool("build", NEW)], [finding("build")]),
      packageDir: dir,
    });
    expect(plan.refused[0]).toMatchObject({ reason: "no_text" });
  });

  test("only restorable rules are considered", () => {
    // `undocumented_optional` has no deleted sentence to put back. Inventing
    // one would be writing documentation on the provider's behalf.
    write("dist/pack.js", `const d = "${NEW}";`);
    const plan = planPatch({
      report: report([tool("build", OLD)], [tool("build", NEW)], [finding("build", "undocumented_optional")]),
      packageDir: dir,
    });
    expect(plan.edits).toEqual([]);
    expect(plan.refused).toEqual([]);
  });

  test("one restoration per tool however many findings point at it", () => {
    write("dist/pack.js", `const d = "${NEW}";`);
    const plan = planPatch({
      report: report(
        [tool("build", OLD)],
        [tool("build", NEW)],
        [finding("build", "guidance_removed"), finding("build", "example_removed")],
      ),
      packageDir: dir,
    });
    expect(plan.edits).toHaveLength(1);
  });
});

describe("applying", () => {
  test("writes the restored text into the file", () => {
    write("dist/pack.js", `const d = "${NEW}";`);
    const plan = planPatch({
      report: report([tool("build", OLD)], [tool("build", NEW)], [finding("build")]),
      packageDir: dir,
    });

    const results = applyPatch(plan, dir);
    expect(results[0]).toMatchObject({ file: "dist/pack.js", applied: true });
    expect(readFileSync(join(dir, "dist/pack.js"), "utf8")).toBe(`const d = "${OLD}";`);
  });

  test("re-checks the bytes and skips an edit whose text has moved", () => {
    // A plan can be minutes old and an install can have run in between.
    // Applying a stale edit is how a patch tool corrupts a file.
    write("dist/pack.js", `const d = "${NEW}";`);
    const plan = planPatch({
      report: report([tool("build", OLD)], [tool("build", NEW)], [finding("build")]),
      packageDir: dir,
    });

    write("dist/pack.js", `const d = "something else entirely";`);
    const results = applyPatch(plan, dir);
    expect(results[0]).toMatchObject({ applied: false });
    expect(readFileSync(join(dir, "dist/pack.js"), "utf8")).toBe(`const d = "something else entirely";`);
  });

  test("applying nothing is not an error", () => {
    expect(applyPatch({ package: "p", version: "1.0.0", edits: [], refused: [] }, dir)).toEqual([]);
  });
});
