import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallRequest, Turn, WireTool } from "./caller.js";
import { createCaller, type CallerProvider } from "./callers.js";

/**
 * Offline throughout: `fetch` is replaced, so no request ever leaves the
 * machine. What is asserted is the *body* — the three providers disagree about
 * how a conversation is spelled, and getting one wrong produces a request that
 * is accepted and means something else.
 */
function stubFetch(payload: unknown) {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    } as unknown as Response;
  });
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOOLS: WireTool[] = [
  {
    name: "make",
    description: "Build a thing.",
    inputSchema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
  },
];

/** A conversation that establishes a name the follow-up can refer back to. */
const HISTORY: Turn[] = [
  { role: "user", text: "build me a store" },
  { role: "call", tool: "make", arguments: { request: "a store" }, result: "Created 'Corner Store'." },
];

const NO_CALL = {
  anthropic: { content: [{ type: "text", text: "ok" }] },
  openai: { choices: [{ message: { content: "ok" } }] },
  gemini: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
};

function callerFor(provider: CallerProvider) {
  return createCaller({ provider, apiKey: "test-key" });
}

async function bodyOf(provider: CallerProvider, request: CallRequest): Promise<Record<string, unknown>> {
  const bodies = stubFetch(NO_CALL[provider]);
  await callerFor(provider).call(request);
  return bodies[0] as Record<string, unknown>;
}

describe("a first-turn request", () => {
  // This is the compatibility property the whole optional-history design rests
  // on. If adding the field changed the body of a request with no history,
  // every cassette recorded before it existed would stop matching.
  it("sends exactly one user message on every provider", async () => {
    const request: CallRequest = { intent: "build me a store", tools: TOOLS };

    expect((await bodyOf("anthropic", request))["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "build me a store" }] },
    ]);

    expect((await bodyOf("openai", request))["messages"]).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: "build me a store" },
    ]);

    expect((await bodyOf("gemini", request))["contents"]).toEqual([
      { role: "user", parts: [{ text: "build me a store" }] },
    ]);
  });
});

describe("prior turns, anthropic", () => {
  it("pairs the call with its result and ends on the intent", async () => {
    const body = await bodyOf("anthropic", {
      intent: "add a checkout page",
      tools: TOOLS,
      history: HISTORY,
    });

    expect(body["messages"]).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "build me a store" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "stantal_1", name: "make", input: { request: "a store" } }],
      },
      {
        // The result rides in a user message, and the follow-up joins it rather
        // than starting a second one — a run of same-role messages is rejected.
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "stantal_1", content: "Created 'Corner Store'." },
          { type: "text", text: "add a checkout page" },
        ],
      },
    ]);
  });

  it("merges consecutive turns of the same role", async () => {
    const body = await bodyOf("anthropic", {
      intent: "and one more thing",
      tools: TOOLS,
      history: [
        { role: "user", text: "first" },
        { role: "user", text: "second" },
      ],
    });

    expect(body["messages"]).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "text", text: "and one more thing" },
        ],
      },
    ]);
  });
});

describe("prior turns, openai", () => {
  it("carries arguments as a JSON string and matches the tool_call_id", async () => {
    const body = await bodyOf("openai", {
      intent: "add a checkout page",
      tools: TOOLS,
      history: HISTORY,
    });

    const messages = body["messages"] as Array<Record<string, unknown>>;

    expect(messages[1]).toEqual({ role: "user", content: "build me a store" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "stantal_1",
          type: "function",
          // A string, not an object. Sending an object here is accepted by the
          // schema and rejected by the API.
          function: { name: "make", arguments: '{"request":"a store"}' },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "stantal_1",
      content: "Created 'Corner Store'.",
    });
    expect(messages[4]).toEqual({ role: "user", content: "add a checkout page" });
  });
});

describe("prior turns, gemini", () => {
  it("uses `model` for the assistant and answers by function name", async () => {
    const body = await bodyOf("gemini", {
      intent: "add a checkout page",
      tools: TOOLS,
      history: [{ role: "assistant", text: "sure" }, ...HISTORY],
    });

    expect(body["contents"]).toEqual([
      // Not "assistant" — Gemini rejects that role outright.
      { role: "model", parts: [{ text: "sure" }] },
      { role: "user", parts: [{ text: "build me a store" }] },
      { role: "model", parts: [{ functionCall: { name: "make", args: { request: "a store" } } }] },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "make", response: { result: "Created 'Corner Store'." } } },
        ],
      },
      { role: "user", parts: [{ text: "add a checkout page" }] },
    ]);
  });
});

describe("call ids", () => {
  it("are derived from position, so the same conversation serializes the same way", async () => {
    const request: CallRequest = {
      intent: "and now the checkout",
      tools: TOOLS,
      history: [
        { role: "call", tool: "make", arguments: {}, result: "one" },
        { role: "user", text: "again" },
        { role: "call", tool: "make", arguments: {}, result: "two" },
      ],
    };

    const first = JSON.stringify(await bodyOf("openai", request));
    const second = JSON.stringify(await bodyOf("openai", request));

    // Byte-identical across runs is what lets a cassette be found again. A
    // generated id would be a new cache key every time and quietly re-buy every
    // answer already on disk.
    expect(first).toBe(second);
    expect(first).toContain('"id":"stantal_0"');
    expect(first).toContain('"id":"stantal_2"');
  });
});
