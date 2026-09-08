import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { labelFor, parseTarget, readLiveServer, splitCommand } from "./live.js";
import { isEvidencedAbsence } from "../contract/surface.js";

/**
 * Offline throughout. Every server here is a file this test writes and runs
 * with `node`, so nothing is downloaded and no network is touched. It is a real
 * stdio MCP session either way, which is the point: the one reader that speaks
 * the protocol should be tested by speaking it.
 */
const require_ = createRequire(import.meta.url);
const SDK = pathToFileURL(require_.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
const STDIO = pathToFileURL(require_.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;

function serverFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stantal-live-"));
  const path = join(dir, "server.mjs");
  writeFileSync(
    path,
    `import { McpServer } from ${JSON.stringify(SDK)};
import { StdioServerTransport } from ${JSON.stringify(STDIO)};
const server = new McpServer({ name: "fixture", version: "1.0.0" });
${body}
await server.connect(new StdioServerTransport());
`,
    "utf8",
  );
  return path;
}

const WITH_TOOLS = `
server.registerTool(
  "build",
  {
    description: "Build a screen from a request.",
    inputSchema: {},
  },
  async () => ({ content: [] }),
);
`;

describe("splitCommand", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("npx -y foo@1.2.3")).toEqual(["npx", "-y", "foo@1.2.3"]);
  });

  test("keeps a quoted argument whole", () => {
    // A real server command has one of these in it. Splitting inside the quotes
    // would hand the server half a path and it would fail to start.
    expect(splitCommand('node ./server.js --root "C:/My Files"')).toEqual([
      "node",
      "./server.js",
      "--root",
      "C:/My Files",
    ]);
  });

  test("keeps an empty quoted argument", () => {
    expect(splitCommand('node x.js ""')).toEqual(["node", "x.js", ""]);
  });
});

describe("parseTarget", () => {
  test("an http URL is a remote server", () => {
    const target = parseTarget("https://mcp.example.com/sse");
    expect(target.kind).toBe("url");
  });

  test("anything else is a command, and a bare package name is not special", () => {
    // The line that keeps "never run extracted package code" true. A package
    // name does not become `npx -y name`; it becomes a command that will not
    // start, and failing loudly is the correct outcome.
    const target = parseTarget("tavily-mcp");
    expect(target.kind).toBe("command");
    if (target.kind === "command") expect(target.command).toBe("tavily-mcp");
  });

  test("refuses an empty target rather than guessing", () => {
    expect(() => parseTarget("   ")).toThrow();
  });
});

describe("readLiveServer", () => {
  test("reads the tools a running server actually hands out", async () => {
    const path = serverFile(WITH_TOOLS);
    const result = await readLiveServer(parseTarget(`node ${JSON.stringify(path)}`), { timeoutMs: 20_000 });

    expect(result.present).toBe(true);
    if (result.present) {
      expect(result.contract.tools.map((t) => t.name)).toEqual(["build"]);
      expect(result.contract.tools[0]?.description).toBe("Build a screen from a request.");
      expect(result.contract.surface).toBe("mcp-server");
      // Nothing was inferred, so there is nothing to be partial about.
      expect(result.fidelity).toBe("complete");
    }
  }, 30_000);

  /**
   * The invariant this reader lives or dies by. It fails for reasons that have
   * nothing to do with the contract — a missing key, a cold download, a URL
   * that moved — and an empty contract compares as every tool removed.
   */
  test("a server that will not start is a gap, never an empty contract", async () => {
    const result = await readLiveServer(parseTarget("node ./definitely-not-a-file-here.mjs"), {
      timeoutMs: 15_000,
    });

    expect(result.present).toBe(false);
    if (!result.present) {
      expect(result.absence.reason).toBe("server_unreachable");
      // Unevidenced, so `diffSurfaces` refuses to compare against it.
      expect(isEvidencedAbsence(result.absence.reason)).toBe(false);
    }
  }, 30_000);

  test("a server that answers with no tools is an evidenced absence", async () => {
    // The opposite case, and it really is different: we asked over the protocol
    // and it said none. That claim is earned.
    const path = serverFile("");
    const result = await readLiveServer(parseTarget(`node ${JSON.stringify(path)}`), { timeoutMs: 20_000 });

    expect(result.present).toBe(false);
    if (!result.present) {
      expect(result.absence.reason).toBe("no_descriptors");
      expect(isEvidencedAbsence(result.absence.reason)).toBe(true);
    }
  }, 30_000);

  test("labels a side by what was named, since there is no version to use", () => {
    expect(labelFor(parseTarget("https://mcp.example.com/mcp"))).toBe("https://mcp.example.com/mcp");
    expect(labelFor(parseTarget("node ./server.js --port 3000"))).toBe("node ./server.js --port 3000");
  });
});
