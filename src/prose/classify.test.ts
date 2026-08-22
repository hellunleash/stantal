import { describe, expect, test } from "vitest";
import type { ExtractionNote, SurfaceResult } from "../contract/surface.js";
import { EXTRACTOR_VERSION, type Param, type Tool } from "../contract/types.js";
import { classifyProse } from "./classify.js";
import type { Judge, JudgeAnswer } from "./judge.js";

function param(name: string, required: boolean, description: string | null = null): Param {
  return { name, type: "string", required, description, constraints: {} };
}

function surface(tools: Tool[], version = "2.0.0", notes: ExtractionNote[] = []): SurfaceResult {
  return {
    present: true,
    contract: {
      ecosystem: "npm",
      package: "@example/tools",
      version,
      surface: "host-pack",
      extractedAt: "2026-01-01T00:00:00.000Z",
      extractorVersion: EXTRACTOR_VERSION,
      tools,
    },
    fidelity: notes.length === 0 ? "complete" : "partial",
    notes,
  };
}

/** A judge that answers from a fixed table, and quotes real text. */
function scriptedJudge(table: Record<string, { verdict: "yes" | "no" | "unclear"; quote?: string }>): Judge {
  return {
    id: "test:scripted",
    async ask(questions) {
      return questions.map((q): JudgeAnswer => {
        const entry = table[q.id] ?? { verdict: "unclear" as const };
        return { id: q.id, verdict: entry.verdict, quote: entry.quote ?? null };
      });
    },
  };
}

const DESCRIBED = "Build a screen. Pass `slot` only when the request names a place for it to land.";

const BUILD: Tool = {
  name: "build",
  description: DESCRIBED,
  params: [param("request", true), param("slot", false), param("target", false)],
};

describe("undocumented_optional", () => {
  test("flags an optional parameter the description never refers to", async () => {
    const result = await classifyProse(null, surface([BUILD]));
    expect(result.findings.map((f) => f.target)).toEqual(["build.target"]);
  });

  test("does not flag a parameter the description explains in prose", async () => {
    // `slot` has a null description but the tool description says when to pass
    // it. Reporting it would be noise, and noise is what makes a linter ignored.
    const result = await classifyProse(null, surface([BUILD]));
    expect(result.findings.map((f) => f.target)).not.toContain("build.slot");
  });

  test("does not flag a required parameter", async () => {
    const result = await classifyProse(null, surface([BUILD]));
    expect(result.findings.map((f) => f.target)).not.toContain("build.request");
  });

  test("does not flag a parameter that carries its own description", async () => {
    const tool: Tool = { ...BUILD, params: [param("target", false, "Which screen to open.")] };
    const result = await classifyProse(null, surface([tool]));
    expect(result.findings).toEqual([]);
  });

  test("is only a lead until something checks the meaning", async () => {
    const result = await classifyProse(null, surface([BUILD]));
    // A rule can see that no sentence names the parameter. It cannot see whether
    // some sentence explains it without naming it.
    expect(result.findings[0]).toMatchObject({ basis: "deterministic", confidence: "unconfirmed" });
  });

  test("ignores a bare occurrence of the word", async () => {
    // The word "app" is all over a description about building apps. Matching it
    // would call an undocumented parameter documented.
    const tool: Tool = {
      name: "make",
      description: "Create an app from a plain-language request. The app builds itself.",
      params: [param("app", false)],
    };
    const result = await classifyProse(null, surface([tool]));
    expect(result.findings.map((f) => f.target)).toEqual(["make.app"]);
  });
});

describe("the judge", () => {
  test("retires a candidate when it finds the guidance a rule missed", async () => {
    const tool: Tool = {
      name: "build",
      description: "Build a screen. Leave the second field empty to start something new.",
      params: [param("request", true), param("target", false)],
    };
    const judge = scriptedJudge({
      "documented:build.target": {
        verdict: "yes",
        quote: "Leave the second field empty to start something new.",
      },
    });

    const result = await classifyProse(null, surface([tool]), judge);
    // The cheapest thing a judge does here is stop a false report.
    expect(result.findings).toEqual([]);
  });

  test("confirms a candidate and raises it above a guess", async () => {
    const judge = scriptedJudge({ "documented:build.target": { verdict: "no" } });
    const result = await classifyProse(null, surface([BUILD]), judge);
    expect(result.findings[0]).toMatchObject({ basis: "judged", confidence: "likely" });
  });

  test("an unclear answer leaves the finding a lead, it does not drop it", async () => {
    const judge = scriptedJudge({ "documented:build.target": { verdict: "unclear" } });
    const result = await classifyProse(null, surface([BUILD]), judge);
    expect(result.findings[0]).toMatchObject({ confidence: "unconfirmed" });
  });

  test("a fabricated quote is discarded, and cannot flip a finding off", async () => {
    const judge = scriptedJudge({
      "documented:build.target": { verdict: "yes", quote: "Pass `target` whenever you like." },
    });
    const result = await classifyProse(null, surface([BUILD]), judge);
    // That sentence is not in the description. The answer fails closed: the
    // finding survives as unconfirmed rather than being silently retired.
    expect(result.findings[0]).toMatchObject({ target: "build.target", confidence: "unconfirmed" });
  });

  test("an answer for a question that was never asked is ignored", async () => {
    const judge: Judge = {
      id: "test:noisy",
      async ask() {
        return [{ id: "documented:other.thing", verdict: "yes", quote: null }];
      },
    };
    const result = await classifyProse(null, surface([BUILD]), judge);
    expect(result.findings[0]).toMatchObject({ target: "build.target", confidence: "unconfirmed" });
  });
});

describe("guidance_removed", () => {
  const before: Tool = {
    name: "build",
    description: "Build a screen. Pass `target` only when changing an existing one.",
    params: [param("request", true), param("target", false)],
  };
  const after: Tool = {
    name: "build",
    description: "Build a screen.",
    params: [param("request", true), param("target", false)],
  };

  test("reports a sentence that explained a surviving parameter and is gone", async () => {
    const result = await classifyProse(surface([before], "1.0.0"), surface([after]));
    const removed = result.findings.find((f) => f.target === "build.target");
    expect(removed?.rule).toBe("mode_switch_changed");
    expect(removed?.evidence.quote).toBe("Pass `target` only when changing an existing one.");
  });

  test("a text fact is certain and costs no model call", async () => {
    const result = await classifyProse(surface([before], "1.0.0"), surface([after]));
    const removed = result.findings.find((f) => f.rule === "mode_switch_changed");
    expect(removed).toMatchObject({ basis: "deterministic", confidence: "certain", severity: "high" });
  });

  test("reflowed whitespace is not a removal", async () => {
    const reflowed: Tool = { ...before, description: before.description!.replace(/ /g, "\n  ") };
    const result = await classifyProse(surface([before], "1.0.0"), surface([reflowed]));
    expect(result.findings.filter((f) => f.rule === "mode_switch_changed")).toEqual([]);
  });
});

describe("extraction gaps", () => {
  test("says nothing about a tool whose description could not be read", async () => {
    const note: ExtractionNote = {
      code: "description_unresolved",
      scope: "description",
      target: "build",
      evidence: "pack.js:12",
      detail: "test",
    };
    const blind: Tool = { name: "build", description: null, params: [param("target", false)] };

    const result = await classifyProse(null, surface([blind], "2.0.0", [note]));
    // Every prose rule would fire on a null description. Reporting that would be
    // our blind spot dressed up as the package shipping nothing.
    expect(result.findings).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ target: "build.target" });
  });
});
