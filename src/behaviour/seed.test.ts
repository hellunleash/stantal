import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTRACTOR_VERSION, type Contract, type Tool } from "../contract/types.js";
import { scriptedCaller, type ToolChoice } from "./caller.js";
import { callerFromEnv } from "./callers.js";
import { seedIntents } from "./seed.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stantal-seed-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tool(name: string, description: string): Tool {
  return { name, description, params: [] };
}

function contract(tools: Tool[], version = "0.7.0"): Contract {
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

const anchor = contract([tool("make", "Build a screen."), tool("search", "Find things.")]);

function proposing(intents: unknown[]) {
  return scriptedCaller("test:model", (): ToolChoice => ({
    kind: "tool_call",
    tool: "propose_intents",
    arguments: { intents },
  }));
}

describe("seedIntents", () => {
  it("turns proposals into a tagged corpus", async () => {
    const caller = proposing([
      { text: "build me a roles screen", tools: ["make"], expectsNoCall: false },
      { text: "find the invoice from March", tools: ["search"], expectsNoCall: false },
      { text: "what is the capital of France", tools: [], expectsNoCall: true },
    ]);

    const intents = await seedIntents({ anchor, caller, cacheDir: dir });

    expect(intents.map((i) => i.text)).toEqual([
      "build me a roles screen",
      "find the invoice from March",
      "what is the capital of France",
    ]);
    expect(intents[0]?.slice).toEqual(["make"]);
    expect(intents[2]?.expectsNoCall).toBe(true);
  });

  it("drops a slice tag naming a tool the anchor does not declare", async () => {
    // A hallucinated tag would silently exclude the intent from every affected
    // run. Leaving it untagged makes it always run, which is the safe direction.
    const caller = proposing([{ text: "do a thing", tools: ["make", "invented"], expectsNoCall: false }]);
    const intents = await seedIntents({ anchor, caller, cacheDir: dir });
    expect(intents[0]?.slice).toEqual(["make"]);
  });

  it("gives a control no slice, so it always runs", async () => {
    const caller = proposing([{ text: "hello", tools: ["make"], expectsNoCall: true }]);
    const intents = await seedIntents({ anchor, caller, cacheDir: dir });
    expect(intents[0]?.slice).toEqual([]);
  });

  it("ignores a proposal with no usable text", async () => {
    const caller = proposing([{ text: "  ", tools: [], expectsNoCall: false }, { nope: 1 }]);
    expect(await seedIntents({ anchor, caller, cacheDir: dir })).toEqual([]);
  });

  it("returns nothing for a contract with no tools, without calling out", async () => {
    const caller = proposing([]);
    expect(await seedIntents({ anchor: contract([]), caller, cacheDir: dir })).toEqual([]);
    expect(caller.calls).toHaveLength(0);
  });

  it("generates once and reuses the corpus after that", async () => {
    // A 40-release walk pays for generation once. Reusing one corpus is also
    // what makes findings comparable across the walk at all.
    const first = proposing([{ text: "build me a screen", tools: ["make"], expectsNoCall: false }]);
    await seedIntents({ anchor, caller: first, cacheDir: dir });
    expect(first.calls).toHaveLength(1);

    const second = proposing([{ text: "something else entirely", tools: ["make"], expectsNoCall: false }]);
    const intents = await seedIntents({ anchor, caller: second, cacheDir: dir });

    expect(second.calls).toHaveLength(0);
    expect(intents[0]?.text).toBe("build me a screen");
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("regenerates for a different anchor, because the capabilities differ", async () => {
    const first = proposing([{ text: "a", tools: ["make"], expectsNoCall: false }]);
    await seedIntents({ anchor, caller: first, cacheDir: dir });

    const other = contract([tool("deploy", "Ship it.")], "0.7.0");
    const second = proposing([{ text: "b", tools: ["deploy"], expectsNoCall: false }]);
    await seedIntents({ anchor: other, caller: second, cacheDir: dir });

    expect(second.calls).toHaveLength(1);
  });

  it("turns a proposed conversation into turns, call paired with result", async () => {
    const caller = proposing([
      {
        text: "add a checkout page to it",
        tools: ["make"],
        expectsNoCall: false,
        history: [
          {
            user: "build me a store",
            tool: "make",
            arguments: { request: "a store" },
            result: "Created 'Corner Store'.",
          },
        ],
      },
    ]);

    const intents = await seedIntents({ anchor, caller, cacheDir: dir });

    expect(intents[0]?.history).toEqual([
      { role: "user", text: "build me a store" },
      {
        role: "call",
        tool: "make",
        arguments: { request: "a store" },
        result: "Created 'Corner Store'.",
      },
    ]);
  });

  it("drops a call naming a tool the anchor does not declare, and keeps the turn", async () => {
    // Same policy as a hallucinated slice tag. The user turn is the half that
    // carries what the follow-up refers back to, so throwing the whole entry
    // away would discard the point of the intent over a detail nothing measures.
    const caller = proposing([
      {
        text: "rename it",
        tools: ["make"],
        expectsNoCall: false,
        history: [{ user: "build me a store", tool: "invented", result: "Made it." }],
      },
    ]);

    const intents = await seedIntents({ anchor, caller, cacheDir: dir });
    expect(intents[0]?.history).toEqual([{ role: "user", text: "build me a store" }]);
  });

  it("leaves a first-turn intent with no history at all", async () => {
    // Not `[]`. An absent key serializes away, which is what keeps a cassette
    // recorded before conversations existed still matching.
    const caller = proposing([{ text: "build me a store", tools: ["make"], expectsNoCall: false }]);
    const intents = await seedIntents({ anchor, caller, cacheDir: dir });
    expect(intents[0]).not.toHaveProperty("history");
  });

  it("ignores a prior turn with nothing said on it", async () => {
    const caller = proposing([
      {
        text: "carry on",
        tools: ["make"],
        expectsNoCall: false,
        history: [{ user: "   " }, { tool: "make", result: "done" }, { user: "real turn" }],
      },
    ]);

    const intents = await seedIntents({ anchor, caller, cacheDir: dir });
    expect(intents[0]?.history).toEqual([{ role: "user", text: "real turn" }]);
  });

  it("asks about the anchor's tools and shows their descriptions", async () => {
    const caller = proposing([]);
    await seedIntents({ anchor, caller, cacheDir: dir });
    const asked = caller.calls[0]?.intent ?? "";
    expect(asked).toContain("make: Build a screen.");
    expect(asked).toContain("search: Find things.");
  });
});

describe("callerFromEnv", () => {
  it("returns null with no key, which is the normal case", () => {
    expect(callerFromEnv({})).toBeNull();
  });

  it("picks the first provider with a key", () => {
    expect(callerFromEnv({ OPENAI_API_KEY: "k" })?.id).toBe("openai:gpt-4o");
    expect(callerFromEnv({ GEMINI_API_KEY: "k" })?.id).toBe("gemini:gemini-3.6-flash");
  });

  it("honours an explicit provider and model", () => {
    const caller = callerFromEnv({
      OPENAI_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      STANTAL_CALLER: "anthropic",
      STANTAL_CALLER_MODEL: "claude-haiku-4-5",
    });
    expect(caller?.id).toBe("anthropic:claude-haiku-4-5");
  });

  it("can be switched off even with a key present", () => {
    expect(callerFromEnv({ OPENAI_API_KEY: "k", STANTAL_CALLER: "none" })).toBeNull();
  });
});
