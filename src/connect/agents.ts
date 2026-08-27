/**
 * Where a coding agent expects to find an MCP server.
 *
 * Distribution has moved. The upgrade decision used to happen in a terminal
 * with a person reading a changelog; now it happens inside an agent that was
 * told to update some dependencies. A tool that is not reachable from there is
 * not in the room when the decision is made.
 *
 * **Project files only.** Every target here lives inside the repository, not in
 * the user's home directory. Three reasons, in order of how badly getting it
 * wrong would go:
 *
 * 1. A global config is shared by every project on the machine, so a mistake
 *    there breaks work that has nothing to do with us.
 * 2. A project file is committable, so one person running this connects the
 *    whole team.
 * 3. A project file is obvious. Someone who wants us gone deletes four lines
 *    they can see in their own diff.
 */

export type AgentId = "claude-code" | "cursor" | "vscode";

export type AgentTarget = {
  id: AgentId;
  label: string;
  /** Repository-relative path to the config file. */
  file: string;
  /**
   * The object key holding the server map.
   *
   * Not the same everywhere, and getting it wrong writes a file the agent
   * reads as empty — which looks exactly like a tool that does not work.
   */
  key: "mcpServers" | "servers";
  /** Executables that indicate this agent is in use. */
  binaries: string[];
  /** Directories or files that indicate this agent is in use in this project. */
  markers: string[];
  /** What to tell the user once the config is written. */
  next: string;
};

export const AGENTS: readonly AgentTarget[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    file: ".mcp.json",
    key: "mcpServers",
    binaries: ["claude"],
    markers: [".mcp.json", ".claude"],
    next: "Restart Claude Code, approve the server when it asks, then say: check my dependencies with stantal",
  },
  {
    id: "cursor",
    label: "Cursor",
    file: ".cursor/mcp.json",
    key: "mcpServers",
    binaries: ["cursor", "cursor-agent"],
    markers: [".cursor"],
    next: "Reload Cursor, enable the server in Settings → MCP, then ask it to check your dependencies with stantal",
  },
  {
    id: "vscode",
    label: "VS Code",
    file: ".vscode/mcp.json",
    key: "servers",
    binaries: ["code"],
    markers: [".vscode"],
    next: "Reload VS Code, start the server from the MCP view, then ask Copilot to check your dependencies with stantal",
  },
];

export function agentById(id: string): AgentTarget | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}

/**
 * The server entry itself.
 *
 * Pinned to an exact version on purpose. `stantal@latest` would let a release
 * we publish change somebody's verdict without them taking an upgrade, which is
 * precisely the thing this product exists to warn people about. Doing it to our
 * own users would be indefensible.
 */
export function serverEntry(version: string): {
  command: string;
  args: string[];
} {
  return { command: "npx", args: ["-y", `stantal@${version}`, "mcp"] };
}
