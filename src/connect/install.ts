import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS, serverEntry, type AgentTarget } from "./agents.js";

/**
 * Installing the server into an agent's config.
 *
 * The single rule this file exists to honour: **merge, never replace.** A
 * developer's `.mcp.json` is usually not empty, and overwriting it would take
 * out every other server they had configured. That is a worse outcome than any
 * finding this product could ever report, and it would be discovered by the
 * user, not by us.
 */

export type DetectedAgent = {
  agent: AgentTarget;
  /** Why we think this agent is in use. */
  because: string;
  /**
   * How good the evidence is.
   *
   * A file in the repository says this project uses that agent. A binary on
   * PATH says only that the machine has it installed, which is a much weaker
   * claim — plenty of people have four agents installed and use one of them
   * here. Ranking them keeps us from writing three config files into a
   * repository that wanted one.
   */
  strength: "marker" | "binary";
};

function onPath(binary: string): boolean {
  // `where` on Windows, `command -v` elsewhere. Both exit non-zero when the
  // binary is absent, which is the only signal needed.
  try {
    if (process.platform === "win32") {
      execFileSync("where", [binary], { stdio: "ignore", timeout: 5000 });
    } else {
      execFileSync("command", ["-v", binary], { stdio: "ignore", timeout: 5000, shell: "/bin/sh" });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Which agents this project appears to use.
 *
 * A marker in the repository counts for more than a binary on PATH: somebody
 * may have four agents installed and use one of them here. Both are reported so
 * the reason can be shown, because "we guessed" and "your repo already has a
 * .cursor directory" earn very different amounts of trust.
 */
export function detectAgents(directory: string): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const agent of AGENTS) {
    const marker = agent.markers.find((m) => existsSync(join(directory, m)));
    if (marker !== undefined) {
      found.push({ agent, because: `this project already has ${marker}`, strength: "marker" });
      continue;
    }
    const binary = agent.binaries.find((b) => onPath(b));
    if (binary !== undefined) {
      found.push({ agent, because: `${binary} is on your PATH`, strength: "binary" });
    }
  }

  // Evidence from the repository wins outright. Having cursor installed is not
  // a reason to write a .cursor directory into a project that never had one.
  const marked = found.filter((f) => f.strength === "marker");
  return marked.length > 0 ? marked : found;
}

export type InstallResult = {
  agent: AgentTarget;
  file: string;
  /** `added` the first time, `updated` when our entry was already there. */
  action: "added" | "updated";
  /** Other servers found in the file and left exactly as they were. */
  preserved: string[];
};

export type InstallOptions = {
  directory: string;
  agent: AgentTarget;
  version: string;
  /** Name the server is registered under. */
  name?: string;
};

/**
 * Write our entry into an agent's config, keeping everything else intact.
 *
 * Reads what is there, adds one key, writes it back. A file that exists but
 * cannot be parsed is an error rather than something to overwrite — a broken
 * JSON file usually means a half-finished edit, and replacing it would throw
 * away work somebody was in the middle of.
 */
export function install(options: InstallOptions): InstallResult {
  const { directory, agent, version } = options;
  const name = options.name ?? "stantal";
  const path = join(directory, agent.file);

  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    if (raw.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not a JSON object");
        }
        config = parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `${agent.file} exists but could not be parsed (${
            error instanceof Error ? error.message : String(error)
          }). Fix or move it first — overwriting it would delete whatever else is configured there.`,
        );
      }
    }
  }

  const existing = config[agent.key];
  const servers: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const preserved = Object.keys(servers).filter((k) => k !== name);
  const action: "added" | "updated" = name in servers ? "updated" : "added";
  servers[name] = serverEntry(version);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...config, [agent.key]: servers }, null, 2)}\n`, "utf8");

  return { agent, file: agent.file, action, preserved };
}

/**
 * The prompt handed to an agent when the caller asks us to run one.
 *
 * It used to be the four steps themselves. That made the same four calls in a
 * repository with one contract dependency and in one with twelve, and it never
 * asked the person anything. **It now points at `AGENTS.md` instead**, which is
 * a decision procedure rather than a script: the agent reads what the audit
 * actually found and asks about that.
 *
 * It also survives this prompt never being used. Most people will not pass
 * `--run`; they will open their own agent, which finds `AGENTS.md` on its own
 * because that is what the file is for.
 *
 * Written as a request rather than a set of orders, and it deliberately does
 * not tell the agent to work without confirmation. A tool that silences the
 * approval prompts in somebody's agent has taken a decision that was not its to
 * take, and the first time that goes wrong it goes wrong inside a repository we
 * will never see.
 */
export function setupPrompt(): string {
  return [
    "This project now has the stantal MCP server configured, and an AGENTS.md",
    "section explaining what to do with it.",
    "",
    'Read the "Contract drift (stantal)" section of AGENTS.md and follow it.',
    "",
    "It will have you make one call and then ask me a short set of questions about",
    "what that call actually found. Ask them together, and skip any the result does",
    "not support.",
    "",
    "Do not upgrade anything, and do not change any code other than generated test files.",
  ].join("\n");
}

export type RunResult = { ran: boolean; detail: string };

/**
 * Hand the setup prompt to a locally installed agent.
 *
 * Opt-in, and off by default. Spawning somebody's coding agent is a real side
 * effect: it can edit files and it can spend their tokens. Competitors do it
 * automatically on install, which is a better first-run experience and a worse
 * default, and this is not a place to trade the second for the first.
 */
export function runAgent(agent: AgentTarget, directory: string): RunResult {
  const prompt = setupPrompt();
  const attempts: Array<{ bin: string; args: string[] }> = [];
  if (agent.id === "claude-code") attempts.push({ bin: "claude", args: ["-p", prompt] });
  if (agent.id === "cursor") attempts.push({ bin: "cursor-agent", args: ["-p", prompt] });

  for (const attempt of attempts) {
    if (!onPath(attempt.bin)) continue;
    try {
      execFileSync(attempt.bin, attempt.args, { cwd: directory, stdio: "inherit", timeout: 10 * 60_000 });
      return { ran: true, detail: `${attempt.bin} finished` };
    } catch (error) {
      return { ran: false, detail: `${attempt.bin} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return {
    ran: false,
    detail: `no runnable CLI found for ${agent.label} — the config is written, so start it yourself`,
  };
}
