import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTRACTOR_VERSION, type Contract, type Param, type Tool } from "../contract/types.js";
import { scriptedCaller, type CallRequest, type ToolChoice } from "./caller.js";
import type { Intent } from "./intent.js";
import { behaviourCacheFromEnv, runBehaviour } from "./run.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stantal-behaviour-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function param(name: string, extra: Partial<Param> = {}): Param {
  return { name, type: "string", required: false, description: null, constraints: {}, ...extra };
}

function tool(name: string, params: Param[], description: string | null): Tool {
  return { name, description, params };
}

function contract(tools: Tool[], version: string): Contract {
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

/** Old prose explains when to pass `target`; new prose does not. */
const OLD = contract(
  [tool("make", [param("request", { required: true }), param("target")], "Build a thing. Pass `target` only when editing one that exists.")],
  "0.7.0",
);
const NEW = contract(
  [tool("make", [param("request", { required: true }), param("target")], "Build a thing.")],
  "0.24.0",
);

const intents: Intent[] = [
  { id: "i1", text: "make me a roles screen", slice: ["make"], expectsNoCall: false },
];

/**
 * A model that fills `target` only when the prose does not tell it when to.
 *
 * This is the anchoring failure, scripted: nothing structural changed, the
 * guidance sentence went away, and the model started filling the field.
 */
function proseSensitiveCaller() {
  return scriptedCaller("test:model", (request: CallRequest): ToolChoice => {
    const explains = request.tools[0]?.description?.includes("Pass `target`") === true;
    return {
      kind: "tool_call",
      tool: "make",
      arguments: explains ? { request: "roles screen" } : { request: "roles screen", target: "Roles" },
    };
  });
}

describe("runBehaviour", () => {
  it("catches the field the model started filling", async () => {
    const caller = proseSensitiveCaller();
    const result = await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      caller,
    });

    expect(result.findings.map((f) => f.rule)).toEqual(["optional_field_appeared"]);
    expect(result.findings[0]?.target).toBe("make.target");
    expect(result.k).toBe(5);
  });

  it("runs k times per intent per side", async () => {
    const caller = proseSensitiveCaller();
    await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      caller,
      k: 6,
    });
    expect(caller.calls).toHaveLength(12);
  });

  it("picks full mode for a 0.x minor bump", async () => {
    const result = await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      caller: proseSensitiveCaller(),
    });
    expect(result.mode).toBe("full");
  });
});

describe("affected-intent selection", () => {
  const unrelated: Intent = { id: "i2", text: "search for things", slice: ["search"], expectsNoCall: false };
  const withSearch = (c: Contract, version: string): Contract =>
    contract([...c.tools, tool("search", [param("q", { required: true })], "Search.")], version);

  it("skips intents whose slice did not change", async () => {
    const caller = proseSensitiveCaller();
    const result = await runBehaviour({
      from: { version: "1.0.0", contract: withSearch(OLD, "1.0.0") },
      to: { version: "1.0.1", contract: withSearch(NEW, "1.0.1") },
      intents: [...intents, unrelated],
      caller,
      k: 5,
    });

    expect(result.mode).toBe("affected");
    expect(result.corpus).toBe(2);
    expect(result.replayed).toBe(1);
    expect(caller.calls).toHaveLength(10);
  });

  it("replays the whole corpus on a breaking bump", async () => {
    const result = await runBehaviour({
      from: { version: "1.0.0", contract: withSearch(OLD, "1.0.0") },
      to: { version: "2.0.0", contract: withSearch(NEW, "2.0.0") },
      intents: [...intents, unrelated],
      caller: proseSensitiveCaller(),
      k: 5,
    });

    // A change in one tool can move which tool the model picks, and slice
    // tagging cannot see that.
    expect(result.mode).toBe("full");
    expect(result.replayed).toBe(2);
  });
});

describe("the cassette", () => {
  it("asks once and replays after that", async () => {
    const options = {
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      k: 5,
    };

    const first = proseSensitiveCaller();
    await runBehaviour({ ...options, caller: first, cache: { mode: "record", dir } });
    expect(first.calls).toHaveLength(10);

    const second = proseSensitiveCaller();
    const result = await runBehaviour({ ...options, caller: second, cache: { mode: "record", dir } });
    expect(second.calls).toHaveLength(0);
    expect(result.stats.hits).toBe(10);
    expect(result.findings.map((f) => f.rule)).toEqual(["optional_field_appeared"]);
  });

  it("keeps k distinct cassettes, not one answer replayed k times", async () => {
    // Collapsing k samples to one would make every interval zero-width and
    // report everything as certain.
    await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      caller: proseSensitiveCaller(),
      k: 5,
      cache: { mode: "record", dir },
    });
    expect(readdirSync(join(dir, "test_model"))).toHaveLength(10);
  });

  it("re-asks when the contract changed by one character", async () => {
    const nudged = contract(
      [tool("make", [param("request", { required: true }), param("target")], "Build a thing!")],
      "0.24.0",
    );

    await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      caller: proseSensitiveCaller(),
      k: 5,
      cache: { mode: "record", dir },
    });

    const second = proseSensitiveCaller();
    const result = await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: nudged },
      intents,
      caller: second,
      k: 5,
      cache: { mode: "record", dir },
    });

    // The old side still replays; the changed side is asked again.
    expect(second.calls).toHaveLength(5);
    expect(result.stats.hits).toBe(5);
  });

  it("never calls out in replay mode", async () => {
    const caller = proseSensitiveCaller();
    const result = await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      caller,
      k: 5,
      cache: { mode: "replay", dir },
    });

    expect(caller.calls).toHaveLength(0);
    // No samples means no runs, so nothing is claimed rather than guessed.
    expect(result.findings).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("writes nothing when the cache is off", async () => {
    const caller = proseSensitiveCaller();
    await runBehaviour({
      from: { version: "0.7.0", contract: OLD },
      to: { version: "0.24.0", contract: NEW },
      intents,
      caller,
      k: 5,
      cache: { mode: "off", dir },
    });
    expect(caller.calls).toHaveLength(10);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("behaviourCacheFromEnv", () => {
  it("records by default", () => {
    expect(behaviourCacheFromEnv({}).mode).toBe("record");
  });

  it("reads replay and off", () => {
    expect(behaviourCacheFromEnv({ STANTAL_BEHAVIOUR_CACHE: "replay" }).mode).toBe("replay");
    expect(behaviourCacheFromEnv({ STANTAL_BEHAVIOUR_CACHE: "OFF" }).mode).toBe("off");
  });

  it("ignores a value it does not understand", () => {
    expect(behaviourCacheFromEnv({ STANTAL_BEHAVIOUR_CACHE: "maybe" }).mode).toBe("record");
  });
});
