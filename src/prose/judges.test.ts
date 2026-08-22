import { afterEach, describe, expect, test, vi } from "vitest";
import { createJudge, judgeFromEnv, parseAnswers } from "./judges.js";

/** Offline throughout: `fetch` is replaced, so no request ever leaves the machine. */
function stubFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    } as unknown as Response;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const QUESTION = {
  id: "documented:build.target",
  kind: "is_parameter_documented" as const,
  tool: "build",
  param: "target",
  description: "Build a screen.",
};

describe("parseAnswers", () => {
  test("reads the plain shape", () => {
    expect(parseAnswers('{"answers":[{"id":"a","verdict":"no","quote":null}]}')).toEqual([
      { id: "a", verdict: "no", quote: null },
    ]);
  });

  test("reads it out of a fenced block or surrounding prose", () => {
    const fenced = 'Here you go:\n```json\n{"answers":[{"id":"a","verdict":"yes","quote":"x"}]}\n```';
    expect(parseAnswers(fenced)).toEqual([{ id: "a", verdict: "yes", quote: "x" }]);
  });

  test("drops an entry with a verdict outside the enum", () => {
    // The taxonomy is closed. A verdict that is not in it is not a weaker
    // answer, it is no answer.
    expect(parseAnswers('{"answers":[{"id":"a","verdict":"probably"}]}')).toEqual([]);
  });

  test("returns nothing for a reply it cannot parse", () => {
    expect(parseAnswers("I could not determine this.")).toEqual([]);
  });
});

describe("createJudge", () => {
  test("calls Anthropic with the key in a header and reads the text back", async () => {
    const calls = stubFetch({
      content: [{ type: "text", text: '{"answers":[{"id":"documented:build.target","verdict":"no","quote":null}]}' }],
    });
    const judge = createJudge({ provider: "anthropic", apiKey: "test-key" });

    expect(judge.id).toBe("anthropic:claude-opus-5");
    expect(await judge.ask([QUESTION])).toEqual([
      { id: "documented:build.target", verdict: "no", quote: null },
    ]);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.headers["x-api-key"]).toBe("test-key");
  });

  test("calls OpenAI and reads the choice back", async () => {
    stubFetch({
      choices: [{ message: { content: '{"answers":[{"id":"documented:build.target","verdict":"yes","quote":"Build a screen."}]}' } }],
    });
    const judge = createJudge({ provider: "openai", apiKey: "k", model: "gpt-4o-mini" });
    expect(judge.id).toBe("openai:gpt-4o-mini");
    expect((await judge.ask([QUESTION]))[0]?.verdict).toBe("yes");
  });

  test("calls Gemini and reads the candidate back", async () => {
    const calls = stubFetch({
      candidates: [{ content: { parts: [{ text: '{"answers":[{"id":"documented:build.target","verdict":"unclear"}]}' }] } }],
    });
    const judge = createJudge({ provider: "gemini", apiKey: "k" });
    expect((await judge.ask([QUESTION]))[0]?.verdict).toBe("unclear");
    // The key belongs in a header. In a query string it ends up in access logs.
    expect(calls[0]?.url).not.toContain("k");
    expect(calls[0]?.headers["x-goog-api-key"]).toBe("k");
  });

  test("never sends anything when there is nothing to ask", async () => {
    const calls = stubFetch({});
    await createJudge({ provider: "anthropic", apiKey: "k" }).ask([]);
    expect(calls).toEqual([]);
  });

  test("raises a typed error on a failed call rather than returning silence", async () => {
    stubFetch({ error: "nope" }, 401);
    // Silence would look like "the judge had no opinion", which would quietly
    // downgrade every finding instead of telling the user their key is wrong.
    await expect(createJudge({ provider: "openai", apiKey: "bad" }).ask([QUESTION])).rejects.toThrow(
      /returned 401/,
    );
  });

  test("asks every question in one call", async () => {
    const calls = stubFetch({ content: [{ type: "text", text: '{"answers":[]}' }] });
    await createJudge({ provider: "anthropic", apiKey: "k" }).ask([
      QUESTION,
      { ...QUESTION, id: "documented:build.other", param: "other" },
    ]);
    expect(calls).toHaveLength(1);
    const prompt = JSON.stringify(calls[0]?.body);
    expect(prompt).toContain("documented:build.target");
    expect(prompt).toContain("documented:build.other");
  });
});

describe("judgeFromEnv", () => {
  test("returns null with no key, which is the normal first run", () => {
    // No key is not an error. Layer 1 still reports; findings stay unconfirmed.
    expect(judgeFromEnv({})).toBeNull();
  });

  test("picks up whichever key is present", () => {
    expect(judgeFromEnv({ OPENAI_API_KEY: "k" })?.id).toBe("openai:gpt-4o");
    expect(judgeFromEnv({ GEMINI_API_KEY: "k" })?.id).toBe("gemini:gemini-2.0-flash");
    expect(judgeFromEnv({ GOOGLE_API_KEY: "k" })?.id).toBe("gemini:gemini-2.0-flash");
  });

  test("an explicit provider choice wins over key order", () => {
    const env = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", LEEWAY_JUDGE: "openai" };
    expect(judgeFromEnv(env)?.id).toBe("openai:gpt-4o");
  });

  test("the model is overridable, because a backfill should not run on the priciest model", () => {
    expect(judgeFromEnv({ ANTHROPIC_API_KEY: "k", LEEWAY_JUDGE_MODEL: "claude-haiku-4-5" })?.id).toBe(
      "anthropic:claude-haiku-4-5",
    );
  });

  test("can be switched off even with a key in the environment", () => {
    expect(judgeFromEnv({ ANTHROPIC_API_KEY: "k", LEEWAY_JUDGE: "none" })).toBeNull();
  });
});

describe("transports", () => {
  /** A stand-in for a vendor SDK, so the SDK path runs with nothing installed. */
  function fakeSdk(reply: unknown, seen: { request?: unknown } = {}) {
    class Client {
      constructor(public options: Record<string, unknown>) {}
      messages = {
        create: async (request: unknown) => {
          seen.request = request;
          return reply;
        },
      };
      chat = {
        completions: {
          create: async (request: unknown) => {
            seen.request = request;
            return reply;
          },
        },
      };
      models = {
        generateContent: async (request: unknown) => {
          seen.request = request;
          return reply;
        },
      };
    }
    return { default: Client, Anthropic: Client, OpenAI: Client, GoogleGenAI: Client };
  }

  const ANSWER = '{"answers":[{"id":"documented:build.target","verdict":"no","quote":null}]}';

  test("uses the SDK when one is installed, without any HTTP call", async () => {
    const calls = stubFetch({});
    const seen: { request?: unknown } = {};
    const judge = createJudge({
      provider: "anthropic",
      apiKey: "k",
      loadModule: async () => fakeSdk({ content: [{ type: "text", text: ANSWER }] }, seen),
    });

    expect((await judge.ask([QUESTION]))[0]?.verdict).toBe("no");
    expect(calls).toEqual([]); // the HTTP path never ran
    expect(seen.request).toMatchObject({ model: "claude-opus-5" });
  });

  test("falls back to HTTP when the SDK is not installed", async () => {
    const calls = stubFetch({ content: [{ type: "text", text: ANSWER }] });
    const judge = createJudge({
      provider: "anthropic",
      apiKey: "k",
      loadModule: async () => {
        throw new Error("Cannot find module");
      },
    });

    expect((await judge.ask([QUESTION]))[0]?.verdict).toBe("no");
    expect(calls).toHaveLength(1);
  });

  test("both transports produce the same answer from the same reply", async () => {
    const seen: { request?: unknown } = {};
    const viaSdk = await createJudge({
      provider: "openai",
      apiKey: "k",
      loadModule: async () => fakeSdk({ choices: [{ message: { content: ANSWER } }] }, seen),
    }).ask([QUESTION]);

    stubFetch({ choices: [{ message: { content: ANSWER } }] });
    const viaHttp = await createJudge({ provider: "openai", apiKey: "k", transport: "http" }).ask([QUESTION]);

    // The transport is how the request is sent. It must never be able to change
    // what counts as a finding.
    expect(viaSdk).toEqual(viaHttp);
  });

  test("an explicit sdk transport says so when the package is missing", async () => {
    const judge = createJudge({
      provider: "gemini",
      apiKey: "k",
      transport: "sdk",
      loadModule: async () => {
        throw new Error("Cannot find module");
      },
    });
    await expect(judge.ask([QUESTION])).rejects.toThrow(/@google\/genai/);
  });

  test("an explicit http transport ignores an installed SDK", async () => {
    const calls = stubFetch({ content: [{ type: "text", text: ANSWER }] });
    await createJudge({
      provider: "anthropic",
      apiKey: "k",
      transport: "http",
      loadModule: async () => fakeSdk({ content: [] }),
    }).ask([QUESTION]);
    expect(calls).toHaveLength(1);
  });

  test("the transport is selectable from the environment", () => {
    expect(judgeFromEnv({ OPENAI_API_KEY: "k", LEEWAY_JUDGE_TRANSPORT: "http" })).not.toBeNull();
  });
});
