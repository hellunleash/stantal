import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AGENTS, agentById, serverEntry } from "./agents.js";
import { detectAgents, install, setupPrompt } from "./install.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stantal-connect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const claude = agentById("claude-code")!;

function read(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
}

function write(file: string, value: unknown): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
}

describe("merge, never replace", () => {
  test("an existing server is left exactly as it was", () => {
    // A developer's .mcp.json is usually not empty. Overwriting it would take
    // out every other server they had configured — a worse outcome than any
    // finding this tool could report, and one they would discover, not us.
    write(".mcp.json", {
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    });

    const result = install({ directory: dir, agent: claude, version: "0.2.0" });

    const config = read(".mcp.json") as { mcpServers: Record<string, unknown> };
    expect(Object.keys(config.mcpServers).sort()).toEqual(["github", "stantal"]);
    expect(config.mcpServers["github"]).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(result.preserved).toEqual(["github"]);
    expect(result.action).toBe("added");
  });

  test("keys outside the server map survive", () => {
    write(".mcp.json", { $schema: "https://example.com/schema.json", mcpServers: {} });
    install({ directory: dir, agent: claude, version: "0.2.0" });
    expect(read(".mcp.json")["$schema"]).toBe("https://example.com/schema.json");
  });

  test("running twice updates our entry rather than duplicating it", () => {
    install({ directory: dir, agent: claude, version: "0.1.0" });
    const second = install({ directory: dir, agent: claude, version: "0.2.0" });

    expect(second.action).toBe("updated");
    const servers = (read(".mcp.json") as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(Object.keys(servers)).toEqual(["stantal"]);
    expect(servers["stantal"]).toEqual(serverEntry("0.2.0"));
  });

  test("a file that cannot be parsed is an error, not something to overwrite", () => {
    // Broken JSON usually means a half-finished edit. Replacing it would throw
    // away work somebody was in the middle of.
    write(".mcp.json", "{ mcpServers: { broken");
    expect(() => install({ directory: dir, agent: claude, version: "0.2.0" })).toThrow(/could not be parsed/);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("{ mcpServers: { broken");
  });

  test("a JSON array is refused rather than treated as a config", () => {
    write(".mcp.json", ["not", "a", "config"]);
    expect(() => install({ directory: dir, agent: claude, version: "0.2.0" })).toThrow();
  });

  test("an empty file is treated as no config, not as broken", () => {
    write(".mcp.json", "");
    expect(() => install({ directory: dir, agent: claude, version: "0.2.0" })).not.toThrow();
  });
});

describe("where the entry goes", () => {
  test("creates the file and any directory it needs", () => {
    const cursor = agentById("cursor")!;
    install({ directory: dir, agent: cursor, version: "0.2.0" });
    expect(read(".cursor/mcp.json")).toHaveProperty("mcpServers.stantal");
  });

  test("VS Code uses a different key, and getting it wrong is invisible", () => {
    // A config written under the wrong key parses fine and reads as empty,
    // which looks exactly like a tool that does not work.
    const vscode = agentById("vscode")!;
    install({ directory: dir, agent: vscode, version: "0.2.0" });
    const config = read(".vscode/mcp.json");
    expect(config).toHaveProperty("servers.stantal");
    expect(config).not.toHaveProperty("mcpServers");
  });

  test("every agent writes inside the project, never the home directory", () => {
    // A global config is shared by every project on the machine, so a mistake
    // there breaks work that has nothing to do with this repository.
    for (const agent of AGENTS) {
      expect(agent.file.startsWith("/")).toBe(false);
      expect(agent.file).not.toContain("~");
      expect(agent.file).not.toContain("..");
    }
  });
});

describe("the version is pinned", () => {
  test("the entry names an exact version, never latest", () => {
    // `stantal@latest` would let a release we publish change somebody's verdict
    // without them taking an upgrade — the exact thing this product warns
    // people about. Doing it to our own users would be indefensible.
    expect(serverEntry("0.2.0").args).toEqual(["-y", "stantal@0.2.0", "mcp"]);
    expect(JSON.stringify(serverEntry("0.2.0"))).not.toContain("latest");
  });
});

describe("detection", () => {
  test("a marker in the repository is reason enough", () => {
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    const found = detectAgents(dir);
    expect(found.map((f) => f.agent.id)).toContain("cursor");
    expect(found.find((f) => f.agent.id === "cursor")?.because).toContain(".cursor");
  });

  test("the reason is reported, because a guess earns less trust than a fact", () => {
    write(".mcp.json", { mcpServers: {} });
    const found = detectAgents(dir).find((f) => f.agent.id === "claude-code");
    expect(found?.because).toBe("this project already has .mcp.json");
  });
});

describe("the setup prompt", () => {
  test("never tells the agent to skip confirmation", () => {
    // A tool that silences the approval prompts in somebody's agent has taken
    // a decision that was not its to take, and the first time that goes wrong
    // it goes wrong in a repository we will never see.
    const prompt = setupPrompt().toLowerCase();
    expect(prompt).not.toContain("without confirmation");
    expect(prompt).not.toContain("do not ask");
    expect(prompt).not.toContain("autonomously");
  });

  test("scopes the agent to pinning, and says not to upgrade anything", () => {
    const prompt = setupPrompt();
    expect(prompt).toContain("pin_contract");
    expect(prompt).toContain("Do not upgrade anything");
  });
});
