import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toolsFromListResult } from "./mcp.js";
import { EXTRACTOR_VERSION, type Contract } from "../contract/types.js";
import { fidelityOf, type SurfaceResult } from "../contract/surface.js";

/**
 * The contract a running MCP server actually hands out.
 *
 * Every other reader in this project infers the contract from files: a tarball,
 * a build directory, a serialized manifest. That inference is good and it has a
 * ceiling. Two kinds of contract sit above it:
 *
 * 1. **Servers that build their tools at run time.** The two entry points the
 *    coverage census could not read are both this shape — one assembles its
 *    tools from an OpenAPI document on boot, the other fetches descriptors from
 *    a third-party API. No static reader will ever see those, however good it
 *    gets.
 * 2. **Servers that are not packages.** A deployed server behind a URL has no
 *    tarball, no version and no registry. That is where most of the public MCP
 *    ecosystem lives, and none of it was reachable from here.
 *
 * It is also the only reader whose output is not an inference at all.
 * `tools/list` is the contract, as received, by the client protocol the model's
 * host actually speaks.
 *
 * ### The rule this reader has to respect
 *
 * "Never run extracted package code on the host" is a standing rule in this
 * project, and booting a server runs code. The line that keeps both true:
 *
 * > **The caller names the target. We never synthesize one.**
 *
 * Nothing here turns a package name into `npx -y pkg@version` on its own. A
 * command runs because somebody typed that command, and a URL is contacted
 * because somebody typed that URL. So this reader is never reached by the
 * no-argument audit, never by a history walk, and never as a fallback when a
 * static read came back thin. Those are exactly the paths where a reader that
 * boots things would run a hundred strangers' servers on somebody's laptop.
 */

export type LiveTarget =
  | { kind: "url"; url: string; headers: Record<string, string> }
  | { kind: "command"; command: string; args: string[]; env: Record<string, string> };

export type LiveOptions = {
  /** Give up if the server never answers. Some servers hang on a missing key. */
  timeoutMs?: number;
  /** What to call this side in the report. Defaults to a label from the target. */
  version?: string;
};

/**
 * Split a command line into a program and its arguments.
 *
 * Quotes are honoured because a real server command contains them:
 * `node ./dist/server.js --root "C:/My Files"`. Nothing else is interpreted —
 * no globbing, no variable expansion, no pipes. A shell would run whatever a
 * `;` introduced, and this string is being handed to us to execute.
 */
export function splitCommand(spec: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of spec) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * A target, from what the user typed.
 *
 * Anything that parses as an http or https URL is a remote server. Everything
 * else is a command. There is no third case and no guessing: a bare package
 * name is a command that does not exist, and failing loudly there is better
 * than quietly deciding to download and run it.
 */
export function parseTarget(
  spec: string,
  extra: { headers?: Record<string, string>; env?: Record<string, string> } = {},
): LiveTarget {
  if (/^https?:\/\//i.test(spec)) {
    return { kind: "url", url: spec, headers: extra.headers ?? {} };
  }
  const parts = splitCommand(spec);
  const command = parts[0];
  if (command === undefined || command.length === 0) {
    throw new Error(`"${spec}" is neither a URL nor a command`);
  }
  return { kind: "command", command, args: parts.slice(1), env: extra.env ?? {} };
}

/** A short, stable name for the side, used as the version and in the report. */
export function labelFor(target: LiveTarget): string {
  return target.kind === "url" ? target.url : [target.command, ...target.args].join(" ");
}

/**
 * A server inherits only what it is explicitly given.
 *
 * Same reasoning as the package extractor's `sealedEnv`: a server booted here
 * would otherwise receive every API key on the machine. The caller can add the
 * ones the server genuinely needs, one at a time, and nothing else travels.
 */
function sealedEnv(extra: Record<string, string>): Record<string, string> {
  const keep = ["PATH", "APPDATA", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "SystemRoot"];
  const base: Record<string, string> = { NODE_ENV: "production" };
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return { ...base, ...extra };
}

function transportsFor(target: LiveTarget): Array<{ name: string; open: () => Transport }> {
  if (target.kind === "command") {
    return [
      {
        name: "stdio",
        open: () =>
          new StdioClientTransport({
            command: target.command,
            args: target.args,
            env: sealedEnv(target.env),
            stderr: "pipe",
          }),
      },
    ];
  }

  const requestInit = Object.keys(target.headers).length > 0 ? { headers: target.headers } : undefined;
  // Both HTTP transports declare `sessionId: string | undefined` where the
  // `Transport` interface declares it optional, which this project's
  // `exactOptionalPropertyTypes` treats as a mismatch. It is a difference in
  // how the SDK's own build is configured, not a difference in behaviour: the
  // SDK's `connect` takes exactly these classes. Narrowed here, once, rather
  // than loosening the setting for the whole codebase.
  const asTransport = (t: StreamableHTTPClientTransport | SSEClientTransport): Transport => t as Transport;

  // Streamable HTTP first, then SSE. Streamable HTTP is the current transport
  // and SSE is the one it replaced, and a large share of servers deployed
  // before the change still speak only the old one. Trying the current one
  // first means a modern server never pays for the fallback.
  return [
    {
      name: "http",
      open: () =>
        asTransport(
          new StreamableHTTPClientTransport(new URL(target.url), {
            ...(requestInit === undefined ? {} : { requestInit }),
          }),
        ),
    },
    {
      name: "sse",
      open: () =>
        asTransport(
          new SSEClientTransport(new URL(target.url), {
            ...(requestInit === undefined ? {} : { requestInit }),
          }),
        ),
    },
  ];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read one running server.
 *
 * Returns a `SurfaceResult`, not a `Contract`, and that is the load-bearing
 * choice. A server that refused to boot, timed out, or answered an error must
 * never reach the diff as a contract with no tools, because an empty contract
 * compares as *every tool removed* — the loudest possible false finding, on the
 * one reader most likely to fail for reasons that have nothing to do with the
 * contract. A missing key, a cold `npx`, a network blip: all of those are gaps
 * in our reading, and they are reported as gaps.
 *
 * A server that answers with an empty tool list is the opposite case. It was
 * asked and it said none, so that is an evidenced absence.
 */
export async function readLiveServer(target: LiveTarget, options: LiveOptions = {}): Promise<SurfaceResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const label = labelFor(target);
  const version = options.version ?? label;
  const attempts = transportsFor(target);
  const tried: string[] = [];
  let lastError = "";

  for (const attempt of attempts) {
    tried.push(attempt.name);
    const transport = attempt.open();
    const client = new Client({ name: "stantal", version: EXTRACTOR_VERSION }, { capabilities: {} });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });

    try {
      await Promise.race([client.connect(transport), timeout]);

      // A server states its capabilities during the handshake. One that does
      // not advertise `tools` is not a server we failed to read: it is a
      // resources-only or prompts-only server saying so in the protocol, and
      // calling `tools/list` on it returns an error that would otherwise be
      // recorded as "unreachable". Asking first turns a whole class of false
      // gaps into the evidenced absence it actually is.
      const capabilities = client.getServerCapabilities();
      if (capabilities !== undefined && capabilities.tools === undefined) {
        return {
          present: false,
          absence: {
            ecosystem: "http",
            package: label,
            version,
            surface: "mcp-server",
            reason: "no_descriptors",
            detail: "the server connected and does not advertise the tools capability",
            checked: [`${attempt.name}: ${label}`],
          },
        };
      }

      const listed = await Promise.race([client.listTools(), timeout]);
      const tools = toolsFromListResult(listed);

      const contract: Contract = {
        ecosystem: "http",
        package: label,
        version,
        surface: "mcp-server",
        extractedAt: new Date().toISOString(),
        extractorVersion: EXTRACTOR_VERSION,
        tools,
      };

      if (tools.length === 0) {
        // Evidenced. We asked over the protocol and it answered none.
        return {
          present: false,
          absence: {
            ecosystem: "http",
            package: label,
            version,
            surface: "mcp-server",
            reason: "no_descriptors",
            detail: `the server answered tools/list with no tools`,
            checked: [`${attempt.name}: ${label}`],
          },
        };
      }

      // Nothing is inferred here, so there is nothing to be partial about: the
      // server either answered or it did not.
      return { present: true, contract, fidelity: fidelityOf([]), notes: [] };
    } catch (error) {
      lastError = message(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Always reap. A stranded child process per read would make comparing two
      // servers leave two servers running.
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  return {
    present: false,
    absence: {
      ecosystem: "http",
      package: label,
      version,
      surface: "mcp-server",
      reason: "server_unreachable",
      detail: `could not read tools/list over ${tried.join(" or ")}: ${lastError}`,
      checked: tried.map((name) => `${name}: ${label}`),
    },
  };
}
