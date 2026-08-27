import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exportedSubpaths, fsPackageSource } from "../extract/package-source.js";
import { extractFromModule } from "../extract/module.js";
import { packageDirectory } from "../testkit.js";
import { assertionsFromContract } from "../emit/assertions.js";
import { emitTests, type EmitTarget } from "../emit/write.js";
import { buildReport, exitCodeFor } from "../report.js";
import { pacoteRegistry } from "../registry/npm.js";
import { walkHistory } from "../history.js";
import { planRemedy } from "../remedy/plan.js";
import type { Judge } from "../prose/judge.js";

/**
 * Stantal as an MCP server.
 *
 * The upgrade decision has moved. It used to happen in a terminal with a human
 * reading a changelog; increasingly it happens inside a coding agent that has
 * been told to update some dependencies. This puts the answer where the
 * decision is being made.
 *
 * **These descriptions are the contract, and we of all people should know it.**
 * Every optional parameter below is explained, both on the parameter and in the
 * tool description. That is not politeness — it is the exact defect this
 * project exists to find, and shipping a server that trips our own rule would
 * be the loudest possible argument that the rule does not matter.
 *
 * **Nothing here needs an account, a key or a network call to us.** Two of the
 * four tools never touch the network at all. The other two fetch published
 * tarballs from the registry the user already uses.
 */

/** How long an answer is allowed to get before it stops being useful to a model. */
const MAX_FINDINGS_RENDERED = 40;

function text(value: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return text(JSON.stringify(value, null, 2));
}

/**
 * Which installed dependencies ship a contract a model reads.
 *
 * Offline and quick, because it is the first question and a slow first question
 * does not get asked twice.
 */
export function contractDependencies(directory: string): Array<{
  package: string;
  version: string;
  subpaths: string[];
  tools: number;
}> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(`${directory}/package.json`, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }

  const named = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = manifest[field];
    if (block !== null && typeof block === "object") {
      for (const name of Object.keys(block as Record<string, unknown>)) named.add(name);
    }
  }

  const out: Array<{ package: string; version: string; subpaths: string[]; tools: number }> = [];
  for (const name of [...named].sort()) {
    const dir = packageDirectory(name, directory);
    if (dir === null) continue;
    const source = fsPackageSource(dir);
    const own = source.packageJson();
    if (own === null) continue;
    const version = typeof own["version"] === "string" ? own["version"] : "unknown";

    const withTools: string[] = [];
    let tools = 0;
    for (const subpath of exportedSubpaths(own)) {
      const result = extractFromModule({ package: name, version, subpath, source });
      if (result.present && result.contract.tools.length > 0) {
        withTools.push(subpath);
        tools += result.contract.tools.length;
      }
    }
    // Only packages that actually hand a model a tool set. Listing every
    // dependency would bury the handful that matter under a hundred that
    // cannot be affected by any of this.
    if (withTools.length > 0) out.push({ package: name, version, subpaths: withTools, tools });
  }
  return out;
}

export type ServerOptions = {
  judge?: Judge | null;
  version?: string;
};

export function createServer(options: ServerOptions = {}): McpServer {
  const judge = options.judge ?? null;
  const server = new McpServer({ name: "stantal", version: options.version ?? "0.0.0" });

  server.registerTool(
    "list_contract_dependencies",
    {
      title: "List dependencies that expose a tool contract",
      description:
        "Lists which of this project's installed dependencies hand a language model a tool " +
        "contract — a set of tool names, descriptions and parameters. Start here: most " +
        "dependencies expose nothing of the kind and cannot be affected by contract drift, so " +
        "this narrows a hundred packages down to the few worth checking. Reads node_modules " +
        "only. It makes no network call and never executes any package. " +
        "Pass `directory` only when the project root is not the current working directory.",
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe(
            "Project root holding the package.json to read. Defaults to the current working " +
              "directory, which is correct for a normal repository checkout.",
          ),
      },
    },
    ({ directory }) => {
      const found = contractDependencies(directory ?? process.cwd());
      if (found.length === 0) {
        return text(
          "No installed dependency exposes a tool contract that could be read. That is a " +
            "normal result for most projects, and it means contract drift cannot affect this " +
            "one. It is not a claim that every dependency was readable.",
        );
      }
      return json(found);
    },
  );

  server.registerTool(
    "check_upgrade",
    {
      title: "Check whether an upgrade changes what a model reads",
      description:
        "Compares two published versions of a package and reports whether a language model " +
        "consuming its tools would behave differently. Catches what semver, type-checking and " +
        "tests all miss: a deleted sentence of guidance, a parameter offered with nothing " +
        "explaining when to pass it, a tool quietly renamed. Fetches both versions from the " +
        "registry and reads them statically; neither package is ever executed. " +
        "Pass `subpath` only to restrict the read to one entry point — by default every entry " +
        "point the package exports is read separately, because two of them can disagree. " +
        "Pass `repo` only to also report which of your own files the findings reach.",
      inputSchema: {
        package: z.string().min(1).describe("The npm package name, for example @scope/sdk."),
        from: z.string().min(1).describe("The version currently in use."),
        to: z.string().min(1).describe("The version being considered."),
        subpath: z
          .string()
          .optional()
          .describe(
            'One entry point to read, written as a consumer imports it: "." or "./ai-sdk". ' +
              "Omit it to read every entry point the package exports, which is the default and " +
              "the safer choice when you do not already know which one this project uses.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "A directory of your own code to scan for call sites the findings reach. Omit it to " +
              "skip that scan entirely. The scan is local and read-only; nothing about your " +
              "source leaves the machine.",
          ),
      },
    },
    async ({ package: pkg, from, to, subpath, repo }) => {
      const report = await buildReport({
        package: pkg,
        from,
        to,
        registry: pacoteRegistry(),
        judge,
        ...(subpath === undefined ? {} : { subpaths: [subpath] }),
        ...(repo === undefined ? {} : { repo: (await import("../blast/repo.js")).fsRepoSource(repo) }),
      });

      const lines = [`verdict: ${report.verdict}`, report.headline, ""];
      let shown = 0;
      for (const surface of report.surfaces) {
        for (const change of surface.comparison.diff?.changes ?? []) {
          if (!change.breaking || shown >= MAX_FINDINGS_RENDERED) continue;
          lines.push(`[breaking] ${change.rule} ${change.target} (${surface.subpath})`);
          shown += 1;
        }
        for (const finding of surface.prose.findings) {
          if (shown >= MAX_FINDINGS_RENDERED) continue;
          lines.push(
            `[${finding.severity}/${finding.confidence}] ${finding.rule} ${finding.target} ` +
              `(${surface.subpath}) — ${finding.headline}`,
          );
          shown += 1;
        }
        // Never dropped. A claim we could not support is a different result
        // from no claim, and only one of them lets a reader stop looking.
        for (const withheld of surface.comparison.suppressed) {
          lines.push(`[withheld] ${withheld.rule} ${withheld.target} — extraction could not support this`);
        }
      }
      if (shown === 0) lines.push("Nothing a model would read differently.");
      lines.push("", `exit code if run as a CLI: ${exitCodeFor(report.verdict)}`);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "pin_contract",
    {
      title: "Write contract tests for an installed dependency",
      description:
        "Reads the version of a package installed right now and writes a Vitest suite recording " +
        "what it offers: which tools exist, which parameters they take, and which of those are " +
        "required. The suite passes today and fails the day an upgrade takes any of it away, so " +
        "it keeps protecting this project with no further involvement from anyone. Reads " +
        "node_modules only — no network call, and the package is never executed. " +
        "Pass `out` only to put the files somewhere other than the default stantal/ directory. " +
        "Pass `subpath` only to pin one entry point instead of every one the package exports.",
      inputSchema: {
        package: z.string().min(1).describe("The npm package name to pin. It must already be installed."),
        out: z
          .string()
          .optional()
          .describe(
            'Directory to write the test files into. Defaults to "stantal", kept separate from ' +
              "hand-written tests so regenerating never overwrites somebody's edits.",
          ),
        subpath: z
          .string()
          .optional()
          .describe(
            'One entry point to pin, written as a consumer imports it: "." or "./ai-sdk". Omit ' +
              "it to pin every entry point the package exports, which is the default.",
          ),
        directory: z
          .string()
          .optional()
          .describe(
            "Project root to resolve node_modules from and write into. Defaults to the current " +
              "working directory.",
          ),
      },
    },
    ({ package: pkg, out, subpath, directory }) => {
      const root = directory ?? process.cwd();
      const dir = packageDirectory(pkg, root);
      if (dir === null) {
        return text(
          `${pkg} is not installed under any node_modules above ${root}. Contract tests pin the ` +
            `version actually in use, so it has to be installed first.`,
        );
      }
      const source = fsPackageSource(dir);
      const manifest = source.packageJson();
      const version = manifest !== null && typeof manifest["version"] === "string" ? manifest["version"] : "unknown";
      const subpaths = subpath !== undefined ? [subpath] : exportedSubpaths(manifest ?? {});

      const targets: EmitTarget[] = [];
      const unreadable: string[] = [];
      for (const door of subpaths) {
        const result = extractFromModule({ package: pkg, version, subpath: door, source });
        if (!result.present) {
          unreadable.push(door);
          continue;
        }
        targets.push({
          package: pkg,
          subpath: door,
          version,
          assertions: assertionsFromContract(result.contract, door, result.notes),
        });
      }

      const written = emitTests({ directory: `${root}/${out ?? "stantal"}`, targets });
      if (written.length === 0) {
        return text(
          `Nothing could be pinned for ${pkg}@${version}.` +
            (unreadable.length > 0
              ? ` These entry points could not be read: ${unreadable.join(", ")}. That is a gap in ` +
                `reading the package, not proof it offers nothing.`
              : ""),
        );
      }
      return json({ package: pkg, version, written, unreadable });
    },
  );

  server.registerTool(
    "find_onset",
    {
      title: "Find which release introduced a contract defect",
      description:
        "Walks a package's release history and reports which version each finding first appeared " +
        "in, the last version that was clean, and how many releases carry it. Answers the " +
        "question a stranded consumer actually has: not 'is the latest bad' but 'where can I " +
        "safely go'. This fetches one tarball per release, so it is much slower and heavier than " +
        "check_upgrade — prefer check_upgrade when you already know both versions. " +
        "Pass `since` and `until` to walk part of the history instead of all of it, which is " +
        "worth doing on a package with many releases. Pass `current` to also get a " +
        "recommendation of where to move from the version you are on.",
      inputSchema: {
        package: z.string().min(1).describe("The npm package name to walk."),
        since: z
          .string()
          .optional()
          .describe(
            "Version to start the walk at. Omit it to start at the first published release, " +
              "which is thorough but slow on a package with a long history.",
          ),
        until: z
          .string()
          .optional()
          .describe("Version to stop the walk at. Omit it to walk through to the latest release."),
        current: z
          .string()
          .optional()
          .describe(
            "The version this project is on now. Supply it to also get a recommendation — the " +
              "nearest clean release to move to, or an explicit statement that none exists. Omit " +
              "it to get the history without a recommendation.",
          ),
        subpath: z
          .string()
          .optional()
          .describe(
            'One entry point to walk, written as a consumer imports it: "." or "./ai-sdk". Omit ' +
              "it to walk every entry point the package exports.",
          ),
      },
    },
    async ({ package: pkg, since, until, current, subpath }) => {
      const walk = await walkHistory({
        package: pkg,
        registry: pacoteRegistry(),
        judge,
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        ...(subpath === undefined ? {} : { subpaths: [subpath] }),
      });

      const lines = [
        `${walk.package}: ${walk.versions.length} release(s) walked, ` +
          `${walk.summary.distinctFindings} distinct finding(s), ${walk.summary.silent} with no structural signal`,
        "",
      ];
      for (const onset of walk.onsets) {
        lines.push(
          `${onset.severity}  ${onset.rule}  ${onset.target}  (${onset.subpath})`,
          `  introduced in ${onset.introducedAt}, last clean ${onset.lastCleanVersion ?? "none"}` +
            `, ${onset.releasesAffected} release(s) affected` +
            (onset.resolvedAt === null ? ", still present" : `, resolved in ${onset.resolvedAt}`),
        );
      }

      if (current !== undefined) {
        const remedy = planRemedy({ walk, current });
        lines.push("", `what to do: ${remedy.kind}`, `  ${remedy.headline}`);
        if (remedy.unverifiable.length > 0) {
          lines.push(
            `  skipped as unverifiable: ${remedy.unverifiable.join(", ")} — too little could be read ` +
              `to call them clean, so they were not recommended`,
          );
        }
      }
      return text(lines.join("\n"));
    },
  );

  return server;
}

/** Serve over stdio, which is how a coding agent starts a local MCP server. */
export async function serveStdio(options: ServerOptions = {}): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
