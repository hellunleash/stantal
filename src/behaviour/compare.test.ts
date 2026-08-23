import { describe, expect, it } from "vitest";
import { EXTRACTOR_VERSION, type Contract, type Param, type Tool } from "../contract/types.js";
import { invalidArguments, presentTool, type ToolChoice } from "./caller.js";
import { compareRuns, type IntentRuns } from "./compare.js";
import type { Intent } from "./intent.js";

function param(name: string, extra: Partial<Param> = {}): Param {
  return {
    name,
    type: "string",
    required: false,
    description: null,
    constraints: {},
    ...extra,
  };
}

function tool(name: string, params: Param[], description: string | null = "does a thing"): Tool {
  return { name, description, params };
}

function contract(tools: Tool[], version = "1.0.0"): Contract {
  return {
    ecosystem: "npm",
    package: "example",
    version,
    surface: "host-pack",
    extractedAt: "2026-01-01T00:00:00.000Z",
    extractorVersion: EXTRACTOR_VERSION,
    tools,
  };
}

const intent: Intent = {
  id: "i1",
  text: "make me a screen listing my roles",
  slice: ["make"],
  expectsNoCall: false,
};

function call(name: string, args: Record<string, unknown>): ToolChoice {
  return { kind: "tool_call", tool: name, arguments: args };
}

function repeat(choice: ToolChoice, times: number): ToolChoice[] {
  return Array.from({ length: times }, () => choice);
}

function runs(choices: ToolChoice[], of: Intent = intent): IntentRuns[] {
  return [{ intent: of, choices }];
}

describe("the anchoring shape: a model starts filling an optional field", () => {
  // The whole product in one test. Nothing structural changed — the field was
  // optional before and is optional after, same type, same name. Only the prose
  // moved, and the model's behaviour moved with it.
  const before = contract([tool("make", [param("request", { required: true }), param("target")])]);
  const after = contract(
    [tool("make", [param("request", { required: true }), param("target")], "does a thing, reworded")],
    "2.0.0",
  );

  it("reports it when the change is complete", () => {
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", { request: "roles screen" }), 5)) },
      after: {
        contract: after,
        runs: runs(repeat(call("make", { request: "roles screen", target: "Roles" }), 5)),
      },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule).toBe("optional_field_appeared");
    expect(result.findings[0]?.target).toBe("make.target");
    expect(result.findings[0]?.severity).toBe("high");
    expect(result.findings[0]?.basis).toBe("measured");
  });

  it("keeps the arguments from each side as evidence", () => {
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", { request: "r" }), 5)) },
      after: { contract: after, runs: runs(repeat(call("make", { request: "r", target: "T" }), 5)) },
    });

    expect(result.findings[0]?.evidence.beforeSample).toEqual({ request: "r" });
    expect(result.findings[0]?.evidence.afterSample).toEqual({ request: "r", target: "T" });
    expect(result.findings[0]?.evidence.intent).toBe("make me a screen listing my roles");
  });

  it("says nothing when the behaviour did not change", () => {
    const same = repeat(call("make", { request: "r" }), 5);
    const result = compareRuns({
      before: { contract: before, runs: runs(same) },
      after: { contract: after, runs: runs([...same]) },
    });
    expect(result.findings).toEqual([]);
  });
});

describe("noise must not become a finding", () => {
  const before = contract([tool("make", [param("request", { required: true }), param("target")])]);
  const after = contract([tool("make", [param("request", { required: true }), param("target")])], "2.0.0");

  it("ignores a single differing run", () => {
    // One flip in five is exactly what a stochastic model does on its own. A
    // verdict that flips on rerun is worse than no verdict.
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", { request: "r" }), 5)) },
      after: {
        contract: after,
        runs: runs([...repeat(call("make", { request: "r" }), 4), call("make", { request: "r", target: "T" })]),
      },
    });
    expect(result.findings).toEqual([]);
  });

  it("ignores a four-in-five shift, because k=5 cannot separate it", () => {
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", { request: "r" }), 5)) },
      after: {
        contract: after,
        runs: runs([
          ...repeat(call("make", { request: "r", target: "T" }), 4),
          call("make", { request: "r" }),
        ]),
      },
    });
    expect(result.findings).toEqual([]);
  });

  it("reports the same four-in-five shift once k is large enough", () => {
    // The measurement did not change; the sample did.
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", { request: "r" }), 20)) },
      after: {
        contract: after,
        runs: runs([
          ...repeat(call("make", { request: "r", target: "T" }), 16),
          ...repeat(call("make", { request: "r" }), 4),
        ]),
      },
    });
    expect(result.findings.map((f) => f.rule)).toEqual(["optional_field_appeared"]);
  });

  it("labels an unbalanced comparison underpowered rather than measured", () => {
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", { request: "r" }), 5)) },
      after: { contract: after, runs: runs(repeat(call("make", { request: "r", target: "T" }), 8)) },
    });
    expect(result.findings[0]?.basis).toBe("underpowered");
  });
});

describe("tool selection", () => {
  const before = contract([tool("create", [param("prompt", { required: true })]), tool("edit", [])]);
  const after = contract([tool("create", [param("prompt", { required: true })]), tool("edit", [])], "2.0.0");

  it("reports the model switching tools", () => {
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("create", { prompt: "p" }), 5)) },
      after: { contract: after, runs: runs(repeat(call("edit", {}), 5)) },
    });

    const rules = result.findings.map((f) => f.rule);
    expect(rules).toContain("tool_switched");
    expect(result.findings.find((f) => f.rule === "tool_switched")?.severity).toBe("high");
  });

  it("reports a rename once, not once per direction", () => {
    // Measured on the real anchoring pair before this was fixed: three intents
    // produced six findings, one saying the old name was dropped and one saying
    // the new name was picked up. One event, reported once.
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("create", { prompt: "p" }), 5)) },
      after: { contract: after, runs: runs(repeat(call("edit", {}), 5)) },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule).toBe("tool_switched");
    expect(result.findings[0]?.target).toBe("edit");
    expect(result.findings[0]?.headline).toContain("used to reach `create`");
  });

  it("samples the old tool on the before side of a rename", () => {
    // Sampling the new name on the old side returns nothing, and a finding
    // whose evidence is half empty is one nobody can check.
    const withId = contract(
      [tool("create", [param("prompt", { required: true })]), tool("edit", [param("id")])],
      "2.0.0",
    );
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("create", { prompt: "p" }), 5)) },
      after: { contract: withId, runs: runs(repeat(call("edit", { id: "x" }), 5)) },
    });

    const renamed = result.findings.find((f) => f.rule === "tool_switched");
    expect(renamed?.evidence.beforeSample).toEqual({ prompt: "p" });
    expect(renamed?.evidence.afterSample).toEqual({ id: "x" });
  });

  it("still reports each move separately when it is not a clean swap", () => {
    // Two tools dropped and one gained is not a rename, and calling it one
    // would be inventing a mapping the evidence does not support.
    const wide = contract(
      [tool("create", [param("prompt", { required: true })]), tool("edit", []), tool("make", [])],
      "2.0.0",
    );
    const other: Intent = { id: "i9", text: "do it", slice: [], expectsNoCall: false };
    const result = compareRuns({
      before: {
        contract: wide,
        runs: [
          { intent, choices: repeat(call("create", { prompt: "p" }), 5) },
          { intent: other, choices: repeat(call("edit", {}), 5) },
        ],
      },
      after: {
        contract: wide,
        runs: [
          { intent, choices: repeat(call("make", {}), 5) },
          { intent: other, choices: repeat(call("make", {}), 5) },
        ],
      },
    });

    expect(result.findings.filter((f) => f.rule === "tool_switched")).toHaveLength(2);
  });

  it("does not also report fields on a tool it stopped choosing", () => {
    // One event, reported once. Field rates on an empty sample are meaningless.
    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("create", { prompt: "p" }), 5)) },
      after: { contract: after, runs: runs(repeat(call("edit", {}), 5)) },
    });
    expect(result.findings.every((f) => f.rule === "tool_switched")).toBe(true);
  });
});

describe("calling nothing at all", () => {
  const surface = contract([tool("search", [param("q", { required: true })])]);

  it("reports the model giving up on a request it used to serve", () => {
    const result = compareRuns({
      before: { contract: surface, runs: runs(repeat(call("search", { q: "x" }), 5)) },
      after: {
        contract: surface,
        runs: runs(repeat({ kind: "no_call", text: "Which repository?" }, 5)),
      },
    });

    const found = result.findings.find((f) => f.rule === "call_abandoned");
    expect(found?.severity).toBe("high");
    expect(found?.evidence.afterSample).toBe("Which repository?");
  });

  it("reports the reverse, which is how a false-positive control fails", () => {
    const control: Intent = { id: "c1", text: "what is the weather", slice: [], expectsNoCall: true };
    const result = compareRuns({
      before: {
        contract: surface,
        runs: runs(repeat({ kind: "no_call", text: "I cannot help with that." }, 5), control),
      },
      after: { contract: surface, runs: runs(repeat(call("search", { q: "weather" }), 5), control) },
    });

    expect(result.findings.some((f) => f.rule === "call_introduced")).toBe(true);
  });
});

describe("a field that changed required-ness is not a behaviour finding", () => {
  it("leaves it to Layer 0 rather than reporting one event twice", () => {
    const before = contract([tool("make", [param("target")])]);
    const after = contract([tool("make", [param("target", { required: true })])], "2.0.0");

    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", {}), 5)) },
      after: { contract: after, runs: runs(repeat(call("make", { target: "T" }), 5)) },
    });

    expect(result.findings.some((f) => f.rule.startsWith("optional_field"))).toBe(false);
  });
});

describe("arguments that stop satisfying the contract", () => {
  it("reports it", () => {
    const before = contract([tool("make", [param("count", { type: "number" })])]);
    const after = contract([tool("make", [param("count", { type: "number" })])], "2.0.0");

    const result = compareRuns({
      before: { contract: before, runs: runs(repeat(call("make", { count: 3 }), 5)) },
      after: { contract: after, runs: runs(repeat(call("make", { count: "three" }), 5)) },
    });

    expect(result.findings.some((f) => f.rule === "arguments_invalid")).toBe(true);
  });
});

describe("an intent that ran on only one side", () => {
  it("is skipped and named, never silently dropped", () => {
    const surface = contract([tool("make", [])]);
    const other: Intent = { id: "i2", text: "something else", slice: ["make"], expectsNoCall: false };

    const result = compareRuns({
      before: { contract: surface, runs: runs(repeat(call("make", {}), 5)) },
      after: { contract: surface, runs: runs(repeat(call("make", {}), 5), other) },
    });

    expect(result.skipped.map((s) => s.intentId).sort()).toEqual(["i1", "i2"]);
    expect(result.findings).toEqual([]);
  });
});

describe("invalidArguments", () => {
  it("catches a missing required field", () => {
    const t = tool("make", [param("request", { required: true })]);
    expect(invalidArguments(t, {})).toHaveLength(1);
  });

  it("catches a wrong type and an undeclared key", () => {
    const t = tool("make", [param("count", { type: "number" })]);
    expect(invalidArguments(t, { count: "three" })[0]).toContain("should be number");
    expect(invalidArguments(t, { nope: 1 })[0]).toContain("not a declared parameter");
  });

  it("accepts a valid call", () => {
    const t = tool("make", [param("request", { required: true }), param("count", { type: "number" })]);
    expect(invalidArguments(t, { request: "r", count: 2 })).toEqual([]);
  });

  it("says nothing about a parameter whose type we could not read", () => {
    // `unknown` is our word for a gap. Validating against it would turn our
    // blind spot into the package's error.
    const t = tool("make", [param("thing", { type: "unknown" })]);
    expect(invalidArguments(t, { thing: 42 })).toEqual([]);
  });
});

describe("presenting a contract to a model", () => {
  it("is a clean inverse of the JSON Schema we read", () => {
    const wire = presentTool(
      tool("make", [
        param("request", { required: true, description: "what to build" }),
        param("mode", { constraints: { enum: ["fast", "slow"] } }),
      ]),
    );

    expect(wire.inputSchema).toEqual({
      type: "object",
      properties: {
        request: { type: "string", description: "what to build" },
        mode: { type: "string", enum: ["fast", "slow"] },
      },
      required: ["request"],
    });
  });

  it("omits type for a parameter we could not read, rather than emitting a bad one", () => {
    const wire = presentTool(tool("make", [param("thing", { type: "unknown" })]));
    expect(wire.inputSchema.properties["thing"]).toEqual({});
  });
});
