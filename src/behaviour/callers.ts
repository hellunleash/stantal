import type { CallRequest, ToolCaller, ToolChoice, WireTool } from "./caller.js";

/**
 * Model-backed tool callers.
 *
 * Same three providers as the judge, same plain `fetch`, same reason: the CLI
 * has to stay light for a first `npx`, and nothing here is made truer by a
 * vendor SDK. What differs is the API surface — this uses each provider's
 * native tool-calling endpoint rather than asking for JSON in prose, because
 * the thing being measured *is* the tool call. Asking a model to describe the
 * call it would make measures its introspection, not its behaviour.
 *
 * What leaves the machine: tool names and descriptions from a published
 * package, plus an intent string. Public data either way. No key, no source,
 * and nothing from the user's own repository is ever part of a request.
 */

export type CallerProvider = "anthropic" | "openai" | "gemini";

export type CallerConfig = {
  provider: CallerProvider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Sampling temperature.
   *
   * Left at the provider default rather than pinned to 0. Pinning it would make
   * every one of the k runs identical, which is not a smaller sample — it is a
   * sample of size one wearing a k-shaped label, and every interval would
   * collapse to zero width. The variance is the measurement.
   */
  temperature?: number;
};

export class CallerError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CallerError";
  }
}

const DEFAULT_MODEL: Record<CallerProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  gemini: "gemini-3.6-flash",
};

const DEFAULT_BASE: Record<CallerProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
};

/**
 * The system prompt.
 *
 * Deliberately thin. Every sentence added here is guidance the *contract* did
 * not provide, and the entire measurement is about what the contract alone
 * makes a model do. A prompt that explains how to use tools well would paper
 * over exactly the gap being measured.
 */
export const CALLER_SYSTEM_PROMPT = [
  "You are an assistant with access to tools.",
  "Use them when they fit the request, and answer directly when they do not.",
].join(" ");

type Wire = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  read(payload: unknown): ToolChoice;
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function anthropicTools(tools: readonly WireTool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === null ? {} : { description: tool.description }),
    input_schema: tool.inputSchema,
  }));
}

function openaiTools(tools: readonly WireTool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === null ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
    },
  }));
}

function geminiTools(tools: readonly WireTool[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === null ? {} : { description: tool.description }),
        parameters: tool.inputSchema,
      })),
    },
  ];
}

function wireFor(config: CallerConfig, request: CallRequest): Wire {
  const model = config.model ?? DEFAULT_MODEL[config.provider];
  const base = (config.baseUrl ?? DEFAULT_BASE[config.provider]).replace(/\/+$/, "");
  const temperature = config.temperature;

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
          max_tokens: 2048,
          system: CALLER_SYSTEM_PROMPT,
          tools: anthropicTools(request.tools),
          messages: [{ role: "user", content: request.intent }],
          ...(temperature === undefined ? {} : { temperature }),
        },
        read: (payload) => {
          const content = (payload as { content?: unknown }).content;
          if (!Array.isArray(content)) return { kind: "no_call", text: "" };

          for (const block of content) {
            const b = block as { type?: unknown; name?: unknown; input?: unknown };
            if (b.type === "tool_use" && typeof b.name === "string") {
              return { kind: "tool_call", tool: b.name, arguments: asArguments(b.input) };
            }
          }
          const text = content
            .filter((b) => (b as { type?: unknown }).type === "text")
            .map((b) => textOf((b as { text?: unknown }).text))
            .join("");
          return { kind: "no_call", text };
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
          tools: openaiTools(request.tools),
          messages: [
            { role: "system", content: CALLER_SYSTEM_PROMPT },
            { role: "user", content: request.intent },
          ],
          ...(temperature === undefined ? {} : { temperature }),
        },
        read: (payload) => {
          const choice = (payload as { choices?: unknown[] }).choices?.[0];
          const message = (choice as { message?: Record<string, unknown> } | undefined)?.message;
          const calls = message?.["tool_calls"];

          if (Array.isArray(calls) && calls.length > 0) {
            const fn = (calls[0] as { function?: { name?: unknown; arguments?: unknown } }).function;
            if (typeof fn?.name === "string") {
              return { kind: "tool_call", tool: fn.name, arguments: asArguments(fn.arguments) };
            }
          }
          return { kind: "no_call", text: textOf(message?.["content"]) };
        },
      };

    case "gemini":
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: {
          systemInstruction: { parts: [{ text: CALLER_SYSTEM_PROMPT }] },
          tools: geminiTools(request.tools),
          contents: [{ role: "user", parts: [{ text: request.intent }] }],
          ...(temperature === undefined ? {} : { generationConfig: { temperature } }),
        },
        read: (payload) => {
          const candidate = (payload as { candidates?: unknown[] }).candidates?.[0];
          const parts = (candidate as { content?: { parts?: unknown[] } } | undefined)?.content?.parts;
          if (!Array.isArray(parts)) return { kind: "no_call", text: "" };

          for (const part of parts) {
            const fn = (part as { functionCall?: { name?: unknown; args?: unknown } }).functionCall;
            if (typeof fn?.name === "string") {
              return { kind: "tool_call", tool: fn.name, arguments: asArguments(fn.args) };
            }
          }
          return { kind: "no_call", text: parts.map((p) => textOf((p as { text?: unknown }).text)).join("") };
        },
      };
  }
}

export function createCaller(config: CallerConfig): ToolCaller {
  const model = config.model ?? DEFAULT_MODEL[config.provider];
  const timeoutMs = config.timeoutMs ?? 120_000;

  return {
    id: `${config.provider}:${model}`,

    async call(request) {
      const wire = wireFor(config, request);
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
          throw new CallerError(`${config.provider} returned ${response.status}: ${detail.slice(0, 300)}`);
        }

        return wire.read(await response.json());
      } catch (error) {
        if (error instanceof CallerError) throw error;
        throw new CallerError(`${config.provider} tool call failed`, error);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Pick a caller from the environment.
 *
 * Returns null when no key is present, which is the normal case and not an
 * error: Layer 2 simply does not run, and Layers 0 and 1 still report.
 */
export function callerFromEnv(env: NodeJS.ProcessEnv = process.env): ToolCaller | null {
  const requested = env["STANTAL_CALLER"]?.toLowerCase();
  if (requested === "none") return null;

  const candidates: Array<{ provider: CallerProvider; key: string | undefined }> = [
    { provider: "anthropic", key: env["ANTHROPIC_API_KEY"] },
    { provider: "openai", key: env["OPENAI_API_KEY"] },
    { provider: "gemini", key: env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"] },
  ];

  const chosen =
    requested === undefined
      ? candidates.find((c) => c.key !== undefined && c.key.length > 0)
      : candidates.find((c) => c.provider === requested);

  if (chosen === undefined || chosen.key === undefined || chosen.key.length === 0) return null;

  const model = env["STANTAL_CALLER_MODEL"];
  const baseUrl = env["STANTAL_CALLER_BASE_URL"];
  return createCaller({
    provider: chosen.provider,
    apiKey: chosen.key,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
}
