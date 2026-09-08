import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exportedSubpaths, fsPackageSource } from "../extract/package-source.js";
import { extractFromModule } from "../extract/module.js";
import { packageDirectory } from "../testkit.js";
import { assertionsFromContract } from "../emit/assertions.js";
import { emitTests, type EmitTarget } from "../emit/write.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  buildLocalReport,
  buildManifestReport,
  buildReport,
  countFindings,
  exitCodeFor,
  type Report,
} from "../report.js";
import { pacoteRegistry } from "../registry/npm.js";
import { walkHistory } from "../history.js";
import { planRemedy } from "../remedy/plan.js";
import { fsRepoSource } from "../blast/repo.js";
import {
  auditProject,
  auditVerdict,
  contractDependencies,
  heldByRange,
  isCurrent,
  isUnreachable,
} from "../audit.js";
import type { Judge } from "../prose/judge.js";

export { contractDependencies };

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
 * **Nothing here needs an account, a key or a network call to us.** Three of
 * the seven tools never touch the network at all. The rest fetch published
 * tarballs from the registry the user already uses.
 *
 * **`audit_project` is the front door and the others are follow-ups.** An agent
 * handed six tools has to sequence them, and sequencing them correctly means
 * holding our mental model of the problem — which is our job, not its. One call
 * returns the ranked plan; the rest exist for going deeper on one package once
 * that plan has named it.
 *
 * **Two of the seven are the provider's, not the consumer's.** `check_release`
 * and `compare_manifests` answer the question from the side that causes the
 * problem — I am about to ship this, what does it do to the models already
 * calling me. They were missing for a while, and the effect was that a provider
 * who connected this server was briefed entirely about the half of the product
 * they care about least.
 */

/** How long an answer is allowed to get before it stops being useful to a model. */
const MAX_FINDINGS_RENDERED = 40;

function text(value: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return text(JSON.stringify(value, null, 2));
}

export type ServerOptions = {
  judge?: Judge | null;
  version?: string;
};

/**
 * One report, in the shape a model reads.
 *
 * Shared by every tool that produces a report, so a consumer's answer and a
 * provider's answer are folded identically. Two renderings would eventually
 * disagree about what counts, and the count is the thing an agent acts on.
 */
function renderForModel(report: Report): string {
  const lines = [`verdict: ${report.verdict}`, report.headline, ""];

  // First, and above everything the report merely found. This is the only part
  // that is about a particular repository rather than about the package.
  for (const item of report.breaks.slice(0, MAX_FINDINGS_RENDERED)) {
    lines.push(`[breaks your code] ${item.rule} ${item.target} — ${item.evidence}: ${item.detail}`);
  }
  if (report.breaks.length > 0) lines.push("");

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
    // Never dropped. A claim we could not support is a different result from no
    // claim, and only one of them lets a reader stop looking.
    for (const withheld of surface.comparison.suppressed) {
      lines.push(`[withheld] ${withheld.rule} ${withheld.target} — extraction could not support this`);
    }
  }
  if (shown === 0) lines.push("Nothing a model would read differently.");
  lines.push("", `exit code if run as a CLI: ${exitCodeFor(report.verdict)}`);
  return lines.join("\n");
}

export function createServer(options: ServerOptions = {}): McpServer {
  const judge = options.judge ?? null;
  const server = new McpServer({ name: "stantal", version: options.version ?? "0.0.0" });

  server.registerTool(
    "audit_project",
    {
      title: "Audit this project and return what to do about it",
      description:
        "Answers the whole question in one call: which of this project's dependencies hand a " +
        "language model a tool contract, whether an upgrade is waiting for any of them, what " +
        "that upgrade would change about what the model reads, which of this project's own " +
        "files those changes reach, and which dependencies already have contract tests. " +
        "Returns a ranked plan, worst first. Prefer this over calling " +
        "list_contract_dependencies and check_upgrade separately — the other tools exist for " +
        "following up on one package once this has named it. Fetches published tarballs from " +
        "the registry; no package is ever executed and nothing is written. " +
        "Pass `directory` only when the project root is not the current working directory. " +
        "Pass `skip_reach` only to skip reading this project's own source, which is the slow " +
        "part on a large repository and the only part that reads code you have not published.",
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe(
            "Project root holding the package.json to audit. Defaults to the current working " +
              "directory, which is correct for a normal repository checkout.",
          ),
        skip_reach: z
          .boolean()
          .optional()
          .describe(
            "Set true to skip scanning this project's own files for the places a finding " +
              "touches. Defaults to false, which scans them. Skipping is faster on a large " +
              "repository, but the result can then no longer say whether anything reaches you.",
          ),
      },
    },
    async ({ directory, skip_reach }) => {
      const root = directory ?? process.cwd();
      const result = await auditProject({
        directory: root,
        registry: pacoteRegistry(),
        judge,
        ...(skip_reach === true ? {} : { repo: fsRepoSource(root) }),
      });

      // Shaped for a model rather than handed over raw. A full report per
      // dependency is tens of kilobytes of nested detail, and burying the one
      // line that matters inside it is the same failure this project exists to
      // find. The follow-up tools return the detail when it is wanted.
      return json({
        verdict: auditVerdict(result),
        declared_dependencies: result.declared,
        contract_dependencies: result.entries.length,
        can_run_tests: result.readiness.hasRunner,
        missing_for_tests: result.readiness.missing,
        // Contracts written here rather than installed. On a real application
        // the dependency list covered 1 of 35, because the rest of what a model
        // reads was generated in the repo. An agent that only ever saw the
        // dependencies would confidently report a repo as covered when most of
        // its contract was never looked at.
        authored_contracts: result.authored.map((contract) => ({
          catalog: contract.catalog,
          documents: contract.sources,
          tools: contract.tools,
          // False means nothing is watching it: there is no saved copy, so a
          // regeneration cannot be compared against anything.
          has_baseline: contract.baseline !== null,
        })),
        authored_unreadable: result.authoredNotes.map((n) => ({ where: n.where, detail: n.detail })),
        dependencies: result.entries.map((entry) => ({
          package: entry.package,
          installed: entry.installed,
          latest: entry.latest,
          upgrade_available: entry.latest !== null && !isCurrent(entry),
          tools: entry.tools,
          subpaths: entry.subpaths,
          pinned: entry.pinnedSubpaths.length === entry.subpaths.length,
          unpinned_subpaths: entry.subpaths.filter((s) => !entry.pinnedSubpaths.includes(s)),
          verdict: entry.report?.verdict ?? null,
          headline: entry.report?.headline ?? null,
          findings: entry.report === null ? null : countFindings(entry.report),
          reaches:
            entry.report?.blast?.reaches.slice(0, 8).map((r) => ({
              kind: r.kind,
              target: r.target,
              evidence: r.evidence,
            })) ?? null,
          // The findings are real and this project's declared range admits
          // none of the versions carrying them. Different advice from both
          // "nothing reaches you" and "hold it", so it travels separately.
          held_by_declared_range: heldByRange(entry),
          // Kept, never collapsed into the verdict. "We could not read this"
          // and "we read it and it is fine" are opposite claims.
          unreachable: isUnreachable(entry),
          note: entry.note,
        })),
      });
    },
  );

  server.registerTool(
    "list_contract_dependencies",
    {
      title: "List dependencies that expose a tool contract",
      description:
        "Lists which of this project's installed dependencies hand a language model a tool " +
        "contract — a set of tool names, descriptions and parameters. Most dependencies expose " +
        "nothing of the kind and cannot be affected by contract drift, so this narrows a " +
        "hundred packages down to the few worth checking. Use audit_project instead when you " +
        "want to know what to do about them; this tool answers only what exists, and answers " +
        "it offline. Reads node_modules only. It makes no network call and never executes any " +
        "package. Pass `directory` only when the project root is not the current working " +
        "directory.",
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
        ...(repo === undefined ? {} : { repo: fsRepoSource(repo) }),
      });
      return text(renderForModel(report));
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

  // --- the provider's two, which are the other end of the same dependency ---
  //
  // Everything above answers a consumer's question: something I install is
  // about to move, what does it do to me. These answer the question from the
  // side that causes it — *I* am about to ship, what does this do to the models
  // already calling me. The server exposed only the consumer half, so a
  // provider who connected was briefed about the part of the product they care
  // about least.

  server.registerTool(
    "check_release",
    {
      title: "Check what an unpublished build does to the models already calling you",
      description:
        "The provider's gate before publishing. Reads the build sitting on disk, fetches the " +
        "release you name from the registry, and reports what your next version does to a " +
        "language model consuming your tools — while it still costs minutes to fix rather than " +
        "a deprecation cycle. Nothing is published and nothing is executed. " +
        "Pass `subpath` only to restrict the read to one entry point; by default every entry " +
        "point the package exports is read separately, because two of them can disagree. " +
        "Pass `repo` only to also scan a directory of consuming code — your own examples, " +
        "templates or starters — for the call sites these findings reach.",
      inputSchema: {
        directory: z
          .string()
          .describe("The package root of the build to check: the directory holding its package.json, not its dist."),
        against: z.string().min(1).describe("The published version to compare the build against, for example 1.4.0."),
        package: z
          .string()
          .optional()
          .describe(
            "The published package name. Omit it to use the name in the local package.json, " +
              "which is right unless you are checking a build against a differently named release.",
          ),
        subpath: z
          .string()
          .optional()
          .describe(
            'One entry point to read, written as a consumer imports it: "." or "./ai-sdk". ' +
              "Omit it to read every entry point, which is the default and the safer choice.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "A directory of consuming code to scan for call sites the findings reach. Omit it " +
              "to skip that scan. The scan is local and read-only.",
          ),
      },
    },
    async ({ directory, against, package: named, subpath, repo }) => {
      const local = fsPackageSource(directory);
      const manifest = local.packageJson();
      const pkg = named ?? (typeof manifest?.["name"] === "string" ? manifest["name"] : undefined);
      if (pkg === undefined) {
        // Named rather than guessed. Reading a package under the wrong name
        // reports every tool as removed, which is the loudest possible wrong
        // answer.
        return text(`${directory} has no readable package name — pass \`package\` explicitly.`);
      }

      const report = await buildLocalReport({
        directory,
        against: { package: pkg, version: against, registry: pacoteRegistry() },
        judge,
        ...(subpath === undefined ? {} : { subpaths: [subpath] }),
        ...(repo === undefined ? {} : { repo: fsRepoSource(repo) }),
      });
      return text(renderForModel(report));
    },
  );

  server.registerTool(
    "compare_manifests",
    {
      title: "Compare two serialized tool lists, with nothing fetched",
      description:
        "Compares two tool manifests read from disk and reports what a language model consuming " +
        "them would read differently. No version is resolved and nothing is fetched, so it works " +
        "on a release that is not published, on a contract that never goes to a registry at all, " +
        "and on a tool list a host generates for its own API. Each side accepts an MCP " +
        "tools/list reply, a host-written tool list, or an OpenAPI document, whose operations are " +
        "the contract a generator hands a model. " +
        "Pass several files per side, catalog first, only when the contract is split across " +
        "documents — schemas generated from routes, prose kept where a person edits it. What a " +
        "model receives is the merge. " +
        "Pass `fieldsAt` only when a document nests a descriptor's editable fields under a " +
        "wrapper key, and `repo` only to also scan consuming code.",
      inputSchema: {
        before: z
          .array(z.string().min(1))
          .min(1)
          .describe("Paths to the older side's documents, catalog first. One path is the ordinary case."),
        after: z
          .array(z.string().min(1))
          .min(1)
          .describe("Paths to the newer side's documents, in the same order as `before`."),
        name: z
          .string()
          .optional()
          .describe("What to call the subject in the report. Omit it to use the first filename."),
        fieldsAt: z
          .string()
          .optional()
          .describe(
            'The key a document nests a descriptor\'s fields under, for example "fields". Omit it ' +
              "unless a document is shaped that way; without it those descriptors read as empty.",
          ),
        repo: z.string().optional().describe("A directory of consuming code to scan. Omit it to skip that scan."),
      },
    },
    async ({ before, after, name, fieldsAt, repo }) => {
      const read = (paths: readonly string[]) =>
        paths.map((path) => ({ name: basename(path), text: readFileSync(path, "utf8"), origin: path }));

      const report = await buildManifestReport({
        package: name ?? basename(before[0] ?? "manifest"),
        from: { version: "before", sources: read(before) },
        to: { version: "after", sources: read(after) },
        judge,
        ...(fieldsAt === undefined ? {} : { fieldsKey: fieldsAt }),
        ...(repo === undefined ? {} : { repo: fsRepoSource(repo) }),
      });
      return text(renderForModel(report));
    },
  );


  return server;
}

/** Serve over stdio, which is how a coding agent starts a local MCP server. */
export async function serveStdio(options: ServerOptions = {}): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
