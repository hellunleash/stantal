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

describe("guidance_removed, widened", () => {
  const withParams = (description: string): Tool => ({
    name: "search",
    description,
    params: [param("query", true), param("depth", false, "How deep to go.")],
  });

  const LONG =
    "Searches the web and returns results in natural language. " +
    "Deep search uses smart query expansion and provides high-quality context for each result. " +
    "You can provide additional query variations for even better results.";
  const SHORT = "Searches the web and returns results in natural language.";

  test("fires when guidance about the tool is deleted, not just about a parameter", async () => {
    const result = await classifyProse(surface([withParams(LONG)], "1.0.0"), surface([withParams(SHORT)]));
    // Measured against real histories, the parameter-only version of this rule
    // missed descriptions collapsing from 224 characters to 65.
    const finding = result.findings.find((f) => f.rule === "guidance_removed");
    expect(finding?.target).toBe("search");
    expect(finding?.confidence).toBe("certain");
    expect(finding?.evidence.quote).toContain("smart query expansion");
  });

  test("reports one finding per target, however many sentences went", async () => {
    const result = await classifyProse(surface([withParams(LONG)], "1.0.0"), surface([withParams(SHORT)]));
    // A rewrite that drops six sentences is one event. Six rows would inflate
    // every count downstream.
    expect(result.findings.filter((f) => f.rule === "guidance_removed")).toHaveLength(1);
    expect(result.findings[0]?.headline).toContain("more sentence");
  });

  test("does not fire when a sentence was merely reworded", async () => {
    const reworded = withParams(
      "Searches the web and returns results in natural language. " +
        "Deep search uses smart query expansion, providing high-quality context for every result. " +
        "You can supply additional query variations for even better results.",
    );
    const result = await classifyProse(surface([withParams(LONG)], "1.0.0"), surface([reworded]));
    // Every tightening pass rewrites most sentences. Reporting those would bury
    // the one deletion that matters.
    expect(result.findings.filter((f) => f.rule === "guidance_removed")).toEqual([]);
  });

  test("ignores a trivially short deletion", async () => {
    const before = withParams("Searches the web and returns results in natural language. Fast.");
    const result = await classifyProse(surface([before], "1.0.0"), surface([withParams(SHORT)]));
    expect(result.findings.filter((f) => f.rule === "guidance_removed")).toEqual([]);
  });

  test("narrows to a parameter when the deleted sentence names one", async () => {
    const before: Tool = {
      name: "search",
      description: "Searches the web. Pass `depth` only when a shallow result is not enough for the task.",
      params: [param("query", true), param("depth", false)],
    };
    const after: Tool = { ...before, description: "Searches the web." };
    const result = await classifyProse(surface([before], "1.0.0"), surface([after]));
    expect(result.findings[0]).toMatchObject({ rule: "mode_switch_changed", target: "search.depth" });
  });
});

describe("extraction gaps, scoped", () => {
  const schemaGap: ExtractionNote = {
    code: "descriptor_schema_unresolved",
    scope: "schema",
    target: "search",
    evidence: "pack.js:20",
    detail: "zod",
  };

  test("a schema gap does not silence findings about the tool's prose", async () => {
    const before: Tool = {
      name: "search",
      description: "Searches the web. Deep search expands your query and returns richer context for each hit.",
      params: [],
    };
    const after: Tool = { ...before, description: "Searches the web." };

    const result = await classifyProse(
      surface([before], "1.0.0", [schemaGap]),
      surface([after], "2.0.0", [schemaGap]),
    );
    // A tool whose schema is built by zod still ships a readable description.
    // Collapsing the two gaps threw away most real findings.
    expect(result.findings.map((f) => f.rule)).toEqual(["guidance_removed"]);
  });

  test("a schema gap still silences claims about parameters", async () => {
    const tool: Tool = { name: "search", description: "Searches the web.", params: [param("depth", false)] };
    const result = await classifyProse(null, surface([tool], "2.0.0", [schemaGap]));
    expect(result.findings).toEqual([]);
    expect(result.skipped[0]?.target).toBe("search.depth");
  });
});

describe("a judge that cannot answer", () => {
  /**
   * The judge is optional everywhere in this tool: a key upgrades an answer and
   * is never required to get one. A rate-limited or expired key therefore has
   * to degrade the result to what it would have been with no key at all.
   *
   * Before this, the throw escaped `classifyProse` and took the whole run with
   * it — a complete structural verdict, already computed, discarded because an
   * optional upgrade failed. Measured live against a spent OpenAI key: exit 2
   * and no report at all.
   */
  const failing = (message: string): Judge => ({
    id: "test:unreachable",
    async ask() {
      throw new Error(message);
    },
  });

  test("the findings survive, unconfirmed", async () => {
    const result = await classifyProse(null, surface([BUILD]), failing("429 no credits remaining"));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ confidence: "unconfirmed" });
  });

  test("says why, because a failure and a clean pass are not the same result", async () => {
    // Both produce findings a model did not filter. Only one of them was asked.
    const result = await classifyProse(null, surface([BUILD]), failing("429 no credits remaining"));
    expect(result.judgeError).toContain("429");
    expect(result.judge).toBe("test:unreachable");
  });

  test("no error is recorded when the judge worked", async () => {
    const judge = scriptedJudge({ "documented:build.target": { verdict: "no" } });
    const result = await classifyProse(null, surface([BUILD]), judge);
    expect(result.judgeError).toBeUndefined();
  });

  test("a judge that is never asked cannot fail", async () => {
    // No candidate raises a question, so nothing reaches the judge and a broken
    // one is not a problem worth reporting.
    const noParams: Tool = { name: "ping", description: "Check liveness.", params: [] };
    const result = await classifyProse(null, surface([noParams]), failing("would have thrown"));
    expect(result.judgeError).toBeUndefined();
  });
});
