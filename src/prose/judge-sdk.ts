import type { JudgeProvider } from "./judges.js";

/**
 * The official-SDK transport.
 *
 * The same three calls as the HTTP transport, made through each vendor's own
 * client when it happens to be installed. What that buys is real: typed errors,
 * the vendor's retry and backoff policy, and their credential resolution —
 * which for Anthropic includes profiles and workload identity, not just an
 * environment variable.
 *
 * What it costs, measured: `@anthropic-ai/sdk` is 7 packages, `openai` is 8,
 * `@google/genai` is 49. None of that may sit in `dependencies`, because the
 * first `npx` run has to be fast and most first runs never reach the judge.
 *
 * So the SDKs are loaded dynamically and are never declared. Installed, they are
 * used. Absent, the HTTP transport does the same job. Neither path is the
 * fallback for the other being broken — they are two ways to send one request,
 * and the answer is verified the same way regardless.
 */

export class SdkUnavailableError extends Error {
  constructor(readonly moduleName: string) {
    super(`${moduleName} is not installed — run \`npm install ${moduleName}\` to use the SDK transport`);
    this.name = "SdkUnavailableError";
  }
}

/** Injected in tests so the SDK path can be exercised without installing anything. */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

export const MODULE_FOR: Record<JudgeProvider, string> = {
  anthropic: "@anthropic-ai/sdk",
  openai: "openai",
  gemini: "@google/genai",
};

/**
 * A variable specifier, deliberately.
 *
 * A literal would make the compiler demand the package be installed, and would
 * clash with the vendor's own types once it is. Resolving at runtime keeps the
 * dependency genuinely optional in both directions.
 */
const defaultLoader: ModuleLoader = (specifier) => import(specifier);

export async function loadSdk(provider: JudgeProvider, load: ModuleLoader = defaultLoader): Promise<unknown> {
  const moduleName = MODULE_FOR[provider];
  try {
    return await load(moduleName);
  } catch {
    throw new SdkUnavailableError(moduleName);
  }
}

/** Is the vendor's SDK importable right now? Used to pick a transport automatically. */
export async function sdkAvailable(provider: JudgeProvider, load: ModuleLoader = defaultLoader): Promise<boolean> {
  try {
    await load(MODULE_FOR[provider]);
    return true;
  } catch {
    return false;
  }
}

type Ctor = new (options: Record<string, unknown>) => unknown;

function constructorFrom(module: unknown, named: string): Ctor {
  const candidates = [
    (module as { default?: unknown }).default,
    (module as Record<string, unknown>)[named],
  ];
  const found = candidates.find((c) => typeof c === "function");
  if (found === undefined) throw new TypeError(`could not find a client constructor in the SDK module`);
  return found as Ctor;
}

function call(target: unknown, path: readonly string[], argument: unknown): Promise<unknown> {
  let cursor: unknown = target;
  for (const step of path.slice(0, -1)) {
    if (cursor === null || typeof cursor !== "object") {
      throw new TypeError(`SDK client has no \`${path.join(".")}\``);
    }
    cursor = (cursor as Record<string, unknown>)[step];
  }
  const method = path[path.length - 1];
  const fn = method === undefined ? undefined : (cursor as Record<string, unknown>)[method];
  if (typeof fn !== "function") throw new TypeError(`SDK client has no \`${path.join(".")}\``);
  return Promise.resolve((fn as (a: unknown) => unknown).call(cursor, argument));
}

function textFromBlocks(value: unknown): string {
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text)
    .join("");
}

export type SdkRequest = {
  provider: JudgeProvider;
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  baseUrl?: string | undefined;
  timeoutMs: number;
};

/**
 * One request through the vendor's client, returning the raw reply text.
 *
 * The reply is parsed and quote-checked by the same code that handles the HTTP
 * transport, so a change of transport cannot change what counts as a finding.
 */
export async function askViaSdk(request: SdkRequest, load: ModuleLoader = defaultLoader): Promise<string> {
  const module = await loadSdk(request.provider, load);

  switch (request.provider) {
    case "anthropic": {
      const Anthropic = constructorFrom(module, "Anthropic");
      const client = new Anthropic({
        apiKey: request.apiKey,
        timeout: request.timeoutMs,
        ...(request.baseUrl ? { baseURL: request.baseUrl } : {}),
      });
      const response = await call(client, ["messages", "create"], {
        model: request.model,
        max_tokens: 4096,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
      });
      return textFromBlocks(response);
    }

    case "openai": {
      const OpenAI = constructorFrom(module, "OpenAI");
      const client = new OpenAI({
        apiKey: request.apiKey,
        timeout: request.timeoutMs,
        ...(request.baseUrl ? { baseURL: request.baseUrl } : {}),
      });
      const response = await call(client, ["chat", "completions", "create"], {
        model: request.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
      });
      const choice = (response as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
      return typeof choice?.message?.content === "string" ? choice.message.content : "";
    }

    case "gemini": {
      const GoogleGenAI = constructorFrom(module, "GoogleGenAI");
      const client = new GoogleGenAI({ apiKey: request.apiKey });
      const response = await call(client, ["models", "generateContent"], {
        model: request.model,
        contents: request.prompt,
        config: {
          systemInstruction: request.system,
          responseMimeType: "application/json",
        },
      });
      const text = (response as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
  }
}
