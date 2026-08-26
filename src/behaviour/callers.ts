import { vertexFromEnv, vertexToken, vertexUrl, type VertexConfig } from "../vertex.js";
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
 * package, an intent string, and — when the intent continues a conversation —
 * the prior turns of that conversation. All of it is generated from the
 * package or by the corpus. No key, no source, and nothing from the user's own
 * repository is ever part of a request.
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
  /**
   * OpenAI's `service_tier: "flex"` — roughly half price, higher latency.
   *
   * Opt-in and openai-only. It has not been verified against the live API, only
   * read from OpenAI's docs, so it stays off by default rather than folded into
   * `DEFAULT_MODEL`-style behaviour that every run would inherit. A good fit for
   * recording cassettes, where latency does not matter and cost does.
   */
  serviceTier?: string;
  /**
   * Route gemini through Vertex AI rather than AI Studio.
   *
   * A transport, not an identity: `id` stays `gemini:<model>` either way, so a
   * cassette recorded through one route still answers a question asked through
   * the other. The two differ in who is billed, not in what the model says.
   */
  vertex?: VertexConfig;
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
  openai: "gpt-5.4",
  // Pinned, for the behaviour cassettes recorded against this id. Note this is
  // the *caller* table: the judge keeps its own defaults in `prose/judges.ts`
  // and its own cache, and the two are pinned for separate reasons. Bumping
  // either strands only its own recordings.
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

// --- prior turns ------------------------------------------------------------

/**
 * A deterministic id for the nth tool call in history.
 *
 * Two of the three providers make the result name the call it answers. Deriving
 * that id from the turn's position rather than generating one keeps the request
 * byte-stable across runs, which is the only reason a cassette can be found
 * again.
 */
function historyCallId(index: number): string {
  return `stantal_${index}`;
}

type AnthropicBlock = Record<string, unknown>;
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

function anthropicMessages(request: CallRequest): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  // Anthropic carries a tool_result in the *user* message after the tool_use,
  // and rejects a run of same-role messages. Appending a block to the last
  // message whenever its role already matches satisfies both at once.
  const push = (role: "user" | "assistant", block: AnthropicBlock): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  (request.history ?? []).forEach((turn, index) => {
    switch (turn.role) {
      case "user":
        push("user", { type: "text", text: turn.text });
        break;
      case "assistant":
        push("assistant", { type: "text", text: turn.text });
        break;
      case "call": {
        const id = historyCallId(index);
        push("assistant", { type: "tool_use", id, name: turn.tool, input: turn.arguments });
        push("user", { type: "tool_result", tool_use_id: id, content: turn.result });
        break;
      }
    }
  });

  push("user", { type: "text", text: request.intent });
  return out;
}

function openaiMessages(request: CallRequest): unknown[] {
  const out: unknown[] = [{ role: "system", content: CALLER_SYSTEM_PROMPT }];

  (request.history ?? []).forEach((turn, index) => {
    switch (turn.role) {
      case "user":
        out.push({ role: "user", content: turn.text });
        break;
      case "assistant":
        out.push({ role: "assistant", content: turn.text });
        break;
      case "call": {
        const id = historyCallId(index);
        out.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              // Arguments go on the wire as a JSON string here, not an object.
              function: { name: turn.tool, arguments: JSON.stringify(turn.arguments) },
            },
          ],
        });
        out.push({ role: "tool", tool_call_id: id, content: turn.result });
        break;
      }
    }
  });

  out.push({ role: "user", content: request.intent });
  return out;
}

function geminiContents(request: CallRequest): unknown[] {
  const out: unknown[] = [];

  for (const turn of request.history ?? []) {
    switch (turn.role) {
      case "user":
        out.push({ role: "user", parts: [{ text: turn.text }] });
        break;
      case "assistant":
        // Gemini's word for the assistant is "model".
        out.push({ role: "model", parts: [{ text: turn.text }] });
        break;
      case "call":
        out.push({ role: "model", parts: [{ functionCall: { name: turn.tool, args: turn.arguments } }] });
        // A functionResponse names the function instead of carrying a call id,
        // so nothing has to be synthesized on this path.
        out.push({
          role: "user",
          parts: [{ functionResponse: { name: turn.tool, response: { result: turn.result } } }],
        });
        break;
    }
  }

  out.push({ role: "user", parts: [{ text: request.intent }] });
  return out;
}

/**
 * Does this error body say the model won't take function tools at all?
 *
 * Deliberately read off the provider's own wording rather than a list of
 * known-bad model ids. A model catalogue goes stale the moment a provider
 * ships or retires an id — which is precisely the class of silent breakage
 * this whole product exists to catch, so hardcoding one here would be that
 * failure happening to us. The message on the wire is asked instead of
 * memorised, and it is the provider that has to keep it honest.
 */
function toolsUnsupported(detail: string): boolean {
  const text = detail.toLowerCase();
  const mentionsTools = /\b(tools?|function[ -]?calling)\b/.test(text);
  const mentionsUnsupported = /(not supported|unsupported|does(?:n't| not) support)/.test(text);
  return mentionsTools && mentionsUnsupported;
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
          messages: anthropicMessages(request),
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
          messages: openaiMessages(request),
          ...(temperature === undefined ? {} : { temperature }),
          ...(config.serviceTier === undefined ? {} : { service_tier: config.serviceTier }),
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
        // Same model, same body, same response — only the address and the way
        // the request is signed change. That is why Vertex is a transport here
        // and not a provider: the id stays `gemini:<model>`, so recordings made
        // through either route answer for each other.
        url:
          config.vertex === undefined
            ? `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
            : vertexUrl(config.vertex, model),
        headers:
          config.vertex === undefined
            ? { "content-type": "application/json", "x-goog-api-key": config.apiKey }
            : { "content-type": "application/json", authorization: `Bearer ${vertexToken()}` },
        body: {
          systemInstruction: { parts: [{ text: CALLER_SYSTEM_PROMPT }] },
          tools: geminiTools(request.tools),
          contents: geminiContents(request),
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
          if (toolsUnsupported(detail)) {
            throw new CallerError(
              `${config.provider} model "${model}" rejected the request because it does not support ` +
                `function tools — its own words: ${detail.slice(0, 300)}. Set STANTAL_CALLER_MODEL to a ` +
                `model that does.`,
            );
          }
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

  // Vertex authenticates with an OAuth token rather than an API key, so gemini
  // is reachable there with no `GEMINI_API_KEY` at all. Treating a configured
  // Vertex project as a credential is what stops the availability check from
  // rejecting a provider that is, in fact, available.
  const vertexConfig = vertexFromEnv(env);
  const geminiKey = env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"];

  const candidates: Array<{ provider: CallerProvider; key: string | undefined }> = [
    { provider: "anthropic", key: env["ANTHROPIC_API_KEY"] },
    { provider: "openai", key: env["OPENAI_API_KEY"] },
    { provider: "gemini", key: geminiKey ?? (vertexConfig === null ? undefined : "") },
  ];

  const usable = (c: { key: string | undefined; provider: CallerProvider }): boolean =>
    c.key !== undefined && (c.key.length > 0 || (c.provider === "gemini" && vertexConfig !== null));

  const chosen =
    requested === undefined
      ? candidates.find(usable)
      : candidates.find((c) => c.provider === requested);

  if (chosen === undefined || !usable(chosen)) return null;

  const model = env["STANTAL_CALLER_MODEL"];
  const baseUrl = env["STANTAL_CALLER_BASE_URL"];
  // Only meaningful for gemini; the other providers ignore it.
  const vertex = chosen.provider === "gemini" ? vertexConfig : null;
  // Unverified against the live API — read from OpenAI's docs, not measured —
  // so it stays behind an explicit env var rather than becoming a default every
  // run would pick up.
  const serviceTier = env["STANTAL_SERVICE_TIER"];
  return createCaller({
    provider: chosen.provider,
    // Empty on the Vertex path, where the token in the header is the credential
    // and this field is never read.
    apiKey: chosen.key ?? "",
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(vertex === null ? {} : { vertex }),
  });
}
