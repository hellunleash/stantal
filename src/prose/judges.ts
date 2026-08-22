import { askViaSdk, sdkAvailable, SdkUnavailableError, type ModuleLoader } from "./judge-sdk.js";
import {
  JUDGE_SYSTEM_PROMPT,
  renderQuestion,
  type Judge,
  type JudgeAnswer,
  type JudgeQuestion,
  type Verdict,
} from "./judge.js";

/**
 * Model-backed judges.
 *
 * Three providers, two transports, one code path.
 *
 * Plain HTTP is the floor: it needs nothing installed, so the judge works on a
 * first `npx` the moment a key exists. The vendor SDKs are the ceiling — typed
 * errors, their retry policy, and their own credential resolution — and are used
 * automatically whenever one is installed (see `judge-sdk.ts`).
 *
 * Neither is declared as a dependency. Measured, they cost 7 packages
 * (`@anthropic-ai/sdk`), 8 (`openai`) and 49 (`@google/genai`), which is a lot
 * to carry for a feature most first runs never reach.
 *
 * Both transports send the same prompt and hand the reply to the same parser and
 * the same quote check. Which one ran can never change what counts as a finding,
 * so they are two ways to send one request rather than two behaviours.
 *
 * What leaves the machine: tool names and descriptions from a published package.
 * That is public data. No key, no source, and nothing from the user's own repo
 * is ever part of a question.
 */

export type JudgeProvider = "anthropic" | "openai" | "gemini";

/**
 * How the request is sent.
 *
 * `auto` uses the vendor SDK when it is installed and plain HTTP otherwise, so
 * the tool works with nothing installed and gets the SDK's retries and typed
 * errors for free the moment one is.
 */
export type JudgeTransport = "auto" | "http" | "sdk";

export type JudgeConfig = {
  provider: JudgeProvider;
  apiKey: string;
  model?: string;
  /** Override for a proxy or a compatible endpoint. */
  baseUrl?: string;
  timeoutMs?: number;
  transport?: JudgeTransport;
  /** Injected in tests so the SDK path runs without installing anything. */
  loadModule?: ModuleLoader;
};

export class JudgeError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JudgeError";
  }
}

const DEFAULT_MODEL: Record<JudgeProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
};

const DEFAULT_BASE: Record<JudgeProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
};

/** One prompt for all providers, so answers stay comparable and the cache key means something. */
function buildPrompt(questions: readonly JudgeQuestion[]): string {
  const body = questions
    .map((q, index) => [`### Question ${index + 1} (id: ${q.id})`, "", renderQuestion(q)].join("\n"))
    .join("\n\n");

  return [
    body,
    "",
    "---",
    "",
    "Reply with JSON only, no prose around it, in exactly this shape:",
    '{"answers":[{"id":"<the id above>","verdict":"yes|no|unclear","quote":"<verbatim span or null>"}]}',
    "",
    "One entry per question, using the exact id given.",
  ].join("\n");
}

/**
 * Pull the answer object out of a reply.
 *
 * Models wrap JSON in prose or a fenced block often enough that refusing those
 * replies would throw away good answers. Anything that does not parse into the
 * expected shape yields nothing, and every question with no answer is treated as
 * unclear by `reconcile`.
 */
export function parseAnswers(text: string): JudgeAnswer[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === "string");

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;

    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as { answers?: unknown };
      if (!Array.isArray(parsed.answers)) continue;

      return parsed.answers.flatMap((entry): JudgeAnswer[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const { id, verdict, quote } = entry as Record<string, unknown>;
        if (typeof id !== "string") return [];
        if (verdict !== "yes" && verdict !== "no" && verdict !== "unclear") return [];
        return [{ id, verdict: verdict as Verdict, quote: typeof quote === "string" ? quote : null }];
      });
    } catch {
      continue;
    }
  }

  return [];
}

type Wire = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  read(payload: unknown): string;
};

function textFrom(value: unknown, path: readonly (string | number)[]): string {
  let cursor: unknown = value;
  for (const step of path) {
    if (cursor === null || typeof cursor !== "object") return "";
    cursor = (cursor as Record<string | number, unknown>)[step];
  }
  return typeof cursor === "string" ? cursor : "";
}

function wireFor(config: JudgeConfig, prompt: string): Wire {
  const model = config.model ?? DEFAULT_MODEL[config.provider];
  const base = (config.baseUrl ?? DEFAULT_BASE[config.provider]).replace(/\/+$/, "");

  switch (config.provider) {
    case "anthropic":
      return {
        url: `${base}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model,
          max_tokens: 4096,
          system: JUDGE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        },
        read: (payload) => {
          const content = (payload as { content?: unknown }).content;
          if (!Array.isArray(content)) return "";
          return content
            .filter((b): b is { type: string; text: string } => {
              const block = b as { type?: unknown; text?: unknown };
              return block.type === "text" && typeof block.text === "string";
            })
            .map((b) => b.text)
            .join("");
        },
      };

    case "openai":
      return {
        url: `${base}/v1/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: {
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: JUDGE_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        },
        read: (payload) => textFrom(payload, ["choices", 0, "message", "content"]),
      };

    case "gemini":
      return {
        // The key rides a header, not the query string, so it stays out of logs.
        url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: {
          systemInstruction: { parts: [{ text: JUDGE_SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        },
        read: (payload) => textFrom(payload, ["candidates", 0, "content", "parts", 0, "text"]),
      };
  }
}

/** Which transport a config will actually use, resolved once per run. */
export async function resolveTransport(config: JudgeConfig): Promise<"http" | "sdk"> {
  const requested = config.transport ?? "auto";
  if (requested !== "auto") return requested;
  return (await sdkAvailable(config.provider, config.loadModule)) ? "sdk" : "http";
}

export function createJudge(config: JudgeConfig): Judge {
  const model = config.model ?? DEFAULT_MODEL[config.provider];
  const timeoutMs = config.timeoutMs ?? 120_000;

  return {
    id: `${config.provider}:${model}`,

    async ask(questions) {
      if (questions.length === 0) return [];
      const prompt = buildPrompt(questions);

      if ((await resolveTransport(config)) === "sdk") {
        try {
          return parseAnswers(
            await askViaSdk(
              {
                provider: config.provider,
                apiKey: config.apiKey,
                model,
                system: JUDGE_SYSTEM_PROMPT,
                prompt,
                baseUrl: config.baseUrl,
                timeoutMs,
              },
              config.loadModule,
            ),
          );
        } catch (error) {
          // "install this package" is the most actionable message this layer
          // produces. Wrapping it would bury it in a cause nobody prints.
          if (error instanceof SdkUnavailableError) throw error;
          throw new JudgeError(`${config.provider} SDK judge call failed`, error);
        }
      }

      const wire = wireFor(config, prompt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(wire.url, {
          method: "POST",
          headers: wire.headers,
          body: JSON.stringify(wire.body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new JudgeError(
            `${config.provider} returned ${response.status}: ${detail.slice(0, 300)}`,
          );
        }

        return parseAnswers(wire.read(await response.json()));
      } catch (error) {
        if (error instanceof JudgeError) throw error;
        throw new JudgeError(`${config.provider} judge call failed`, error);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Pick a judge from the environment.
 *
 * Returns null when no key is present, which is the normal case for a first run
 * and is not an error. Layer 1 still produces findings; they are just labelled
 * unconfirmed.
 */
export function judgeFromEnv(env: NodeJS.ProcessEnv = process.env): Judge | null {
  const requested = env["STANTAL_JUDGE"]?.toLowerCase();
  if (requested === "none") return null;

  const candidates: Array<{ provider: JudgeProvider; key: string | undefined }> = [
    { provider: "anthropic", key: env["ANTHROPIC_API_KEY"] },
    { provider: "openai", key: env["OPENAI_API_KEY"] },
    { provider: "gemini", key: env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"] },
  ];

  const chosen =
    requested === undefined
      ? candidates.find((c) => c.key !== undefined && c.key.length > 0)
      : candidates.find((c) => c.provider === requested);

  if (chosen === undefined || chosen.key === undefined || chosen.key.length === 0) return null;

  const model = env["STANTAL_JUDGE_MODEL"];
  const baseUrl = env["STANTAL_JUDGE_BASE_URL"];
  const transport = env["STANTAL_JUDGE_TRANSPORT"]?.toLowerCase();
  return createJudge({
    provider: chosen.provider,
    apiKey: chosen.key,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(transport === "http" || transport === "sdk" || transport === "auto" ? { transport } : {}),
  });
}
