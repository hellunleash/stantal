import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toolFrom } from "../contract/from-json-schema.js";
import { EXTRACTOR_VERSION, type Contract, type Ecosystem, type Tool } from "../contract/types.js";

/**
 * MCP adapter.
 *
 * Boots a package's MCP server and reads `tools/list`, so the contract is
 * whatever a client actually receives rather than whatever the source says.
 *
 * Uses the official SDK client rather than shelling out to the Inspector CLI:
 * one less subprocess, and typed results instead of parsed stdout.
 */

export type McpExtractOptions = {
  /** Package name as published, e.g. "@scope/name". */
  package: string;
  /** Exact published version. Immutable, which is what makes the cache permanent. */
  version: string;
  ecosystem?: Ecosystem;
  /** Command to boot the server. Defaults to running the package via npx at the pinned version. */
  command?: string;
  args?: string[];
  /** Extra env for the server process. The ambient env is NOT inherited by default. */
  env?: Record<string, string>;
  /** Give up if the server never answers. Some packages hang on a missing key. */
  timeoutMs?: number;
};

export class McpExtractionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "McpExtractionError";
  }
}

/**
 * A server inherits only what it is explicitly given.
 *
 * Extraction boots arbitrary published code. Handing it the full ambient
 * environment would hand it every API key on the machine.
 */
function sealedEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    NODE_ENV: "production",
    // npx needs somewhere to cache; without it every boot re-downloads.
    ...(process.env["APPDATA"] ? { APPDATA: process.env["APPDATA"] } : {}),
    ...(process.env["HOME"] ? { HOME: process.env["HOME"] } : {}),
    ...(process.env["USERPROFILE"] ? { USERPROFILE: process.env["USERPROFILE"] } : {}),
    ...(process.env["SYSTEMROOT"] ? { SYSTEMROOT: process.env["SYSTEMROOT"] } : {}),
    ...(process.env["TEMP"] ? { TEMP: process.env["TEMP"] } : {}),
  };
  return { ...base, ...(extra ?? {}) };
}

/** Raw `tools/list` entries -> normalized tools, sorted so contracts compare cleanly. */
export function toolsFromListResult(result: unknown): Tool[] {
  const tools =
    typeof result === "object" && result !== null && Array.isArray((result as { tools?: unknown }).tools)
      ? ((result as { tools: unknown[] }).tools)
      : [];

  return tools
    .map((entry) => {
      const t = (entry ?? {}) as { name?: unknown; description?: unknown; inputSchema?: unknown };
      const name = typeof t.name === "string" ? t.name : "";
      return toolFrom(name, t.description, t.inputSchema);
    })
    .filter((t) => t.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function extractFromMcpServer(options: McpExtractOptions): Promise<Contract> {
  const {
    package: pkg,
    version,
    ecosystem = "npm",
    command = process.platform === "win32" ? "npx.cmd" : "npx",
    args = ["-y", `${pkg}@${version}`],
    env,
    timeoutMs = 60_000,
  } = options;

  const transport = new StdioClientTransport({
    command,
    args,
    env: sealedEnv(env),
    stderr: "pipe",
  });

  const client = new Client(
    { name: "stantal", version: EXTRACTOR_VERSION },
    { capabilities: {} },
  );

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new McpExtractionError(`${pkg}@${version} did not answer tools/list within ${timeoutMs}ms`)),
      timeoutMs,
    ).unref?.();
  });

  try {
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);

    return {
      ecosystem,
      package: pkg,
      version,
      surface: "mcp-server",
      extractedAt: new Date().toISOString(),
      extractorVersion: EXTRACTOR_VERSION,
      tools: toolsFromListResult(listed),
    };
  } catch (err) {
    if (err instanceof McpExtractionError) throw err;
    throw new McpExtractionError(`failed to extract ${pkg}@${version} over MCP`, err);
  } finally {
    // Always reap the child. A stranded server process per extraction would
    // make backfilling a release history unusable.
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
