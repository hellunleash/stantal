#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isEvidencedAbsence, isPresent } from "./contract/surface.js";
import { callerFromEnv } from "./behaviour/callers.js";
import { behaviourCacheFromEnv } from "./behaviour/run.js";
import type { Judge } from "./prose/judge.js";
import { judgeFromEnv } from "./prose/judges.js";
import { fsRepoSource, type RepoSource } from "./blast/repo.js";
import { planRemedy } from "./remedy/plan.js";
import type { Remedy } from "./remedy/taxonomy.js";
import { canClaimUnaffected } from "./blast/taxonomy.js";
import { pacoteRegistry } from "./registry/npm.js";
import { vertexFromEnv } from "./vertex.js";
import { walkHistory, type HistoryResult } from "./history.js";
import {
  buildLocalReport,
  buildManifestReport,
  buildReport,
  countFindings,
  exitCodeFor,
  type BehaviourOptions,
  type Report,
  type SurfaceReport,
} from "./report.js";
import { assertionsFromContract, assertionsFromReport } from "./emit/assertions.js";
import { emitTests, type EmitTarget, type WrittenFile } from "./emit/write.js";
import { testFileName } from "./emit/vitest.js";
import { hostReadiness, readinessNotes } from "./emit/host.js";
import { setupRunner, CONTRACT_SCRIPT } from "./emit/runner.js";
import { extractFromModule } from "./extract/module.js";
import { exportedSubpaths, fsPackageSource } from "./extract/package-source.js";
import { packageDirectory } from "./testkit.js";
import { applyPatch, planPatch } from "./patch/plan.js";
import { renderPatchFile } from "./patch/emit.js";
import { canApply } from "./patch/taxonomy.js";
import { renderHtml } from "./verdict/html.js";
import { publishableReport } from "./verdict/publish.js";
import { AGENTS, agentById } from "./connect/agents.js";
import { detectAgents, install, runAgent, type DetectedAgent, type InstallResult } from "./connect/install.js";
import { writeAgentsMd, type WriteAgentsResult } from "./connect/agents-md.js";
import { serveStdio } from "./serve/mcp.js";
import {
  auditProject,
  auditVerdict,
  contractDependencies,
  heldByRange,
  isCurrent,
  isUnreachable,
  reachCount,
  type AuditEntry,
  type AuditResult,
} from "./audit.js";
import { watchProject, watchSummary } from "./watch.js";

/**
 * Rung 1 — the whole product in one command, with nothing installed.
 *
 *     npx stantal <package> <from> <to>
 *
 * No account, no config, no repo access, no key. A key upgrades the answer; it
 * is never required to get one.
 */

const USAGE = `
stantal — know whether an upgrade changes how a model uses your dependency

  stantal                                  audit this project and say what to do
  stantal pin --all                        protect every contract you depend on
  stantal watch                            for a scheduled job: decide what to say
  stantal <package> <from> <to> [options]
  stantal history <package> [options]
  stantal manifest <before...> <after...> [options]
  stantal check <dir> --against <version> [options]
  stantal pin <package> [options]
  stantal patch <package> <from> [options]
  stantal connect [options]
  stantal mcp

Run it with no arguments in any repository. It finds which of your dependencies
hand a model tools, checks what the upgrade waiting for each of them would
change, works out which of your own files that reaches, and prints a short list
of what to do in order. It reads and ranks; it writes nothing.

Pinning is the step that writes. It reads the version you have installed right
now, records what the package offers — which tools exist, which parameters they
take, which of those are required — and leaves a Vitest suite that passes today
and fails the day an upgrade takes any of it away. Nothing is fetched, the
package is never executed, and the tests keep working whether or not you ever
run this tool again. --all does it for every contract-bearing dependency at
once, and never overwrites a suite that already exists.

Comparing two versions tells you whether to take an upgrade.
Walking the history tells you which release broke it, and the last one that
was fine — which is what a stranded consumer actually needs.
Comparing two manifests answers the other side's question: I am about to ship
this — what will it do to the models already calling me. Nothing is fetched and
no version is resolved, so it works on a release that is not published, and on
a contract that never goes to a registry at all. It reads a serialized tool
list: an MCP tools/list reply, or whatever a host writes out for its own tools.
Checking a directory is the provider's gate before publishing: it reads the
build on disk, fetches the release you name, and tells you what your next
version does to the models already calling you -- while it still costs
minutes to fix rather than a deprecation cycle.

Connecting registers this tool with a coding agent, by writing an MCP entry into
a config file in your repository. That file is committable, so one person
connecting connects the team, and it is four visible lines to delete if you want
it gone. The "mcp" subcommand is the server itself, spoken over stdio; you
rarely run it by hand.

Each side of the manifest form takes a comma-separated list of documents, catalog
first, because a contract is often split - schemas generated from routes, prose
kept where a person edits it. What a model receives is the merge.

Options
  --surface <subpath>   Read one door only, e.g. "." or "./ai-sdk".
                        Repeatable. Default: every subpath the package exports.
  --name <label>        manifest: what to call the subject. Default: the filename.
  --fields-at <key>     manifest: where a descriptor's fields live, when a
                        document nests them under a wrapper.
  --exclude-when <k=v>  manifest: drop tools whose merged descriptor carries
                        this field, for policy the host applies but the
                        document only states. Repeatable.
  --repo <dir>          Layer 3: which of YOUR call sites a finding reaches.
                        Reads that directory only, never writes, never calls
                        out. Defaults to "." — pass "none" to turn it off.
  --all                 pin: every contract-bearing dependency at once.
                        Never overwrites a suite that already exists.
  --write               watch: actually write the contract tests it planned.
                        Off by default; deciding and doing are separate.
  --text                watch: print for a person. Default is JSON, because
                        the caller is usually a workflow.
  --directory <dir>     Project root to read. Default: cwd
  --emit-tests          Write contract tests for what this comparison found,
                        pinning the older side so they fail on the upgrade.
  --out <dir>           Where emitted tests go (default stantal/), or where
                        --emit-patch writes (default patches/).
  --agent <id>          connect: which agent to configure. Detected by default.
  --run                 connect: also hand the setup prompt to that agent.
                        Off by default — starting your agent can edit files
                        and spend tokens, so it is never done on install.
  --emit-patch          patch: write the restoration as a patch file in
                        patches/, which survives npm install and is
                        reviewable as a diff. This is the durable form.
  --apply               patch: also write the edits into node_modules now.
                        Off by default; the plan is printed instead. A fresh
                        install throws these away, so it checks a fix rather
                        than keeping one.
  --html <file>         Also write the verdict as one self-contained HTML page.
                        Nothing is fetched when it is opened, so it can be
                        forwarded to someone who will not run what you send.
  --publish <url>       Send the verdict to a host and print a link to it.
                        Your own file paths are removed first and the removal
                        is printed. There is no built-in address: pass one, or
                        set STANTAL_VERDICT_HOST.
  --json                Print the full report as JSON.
  --no-judge            Skip the model judge even if a key is set.
  --behaviour           Also run Layer 2: put the contract in front of a model
                        and compare what it does. Off by default because it
                        costs k calls per request per side.
  --k <n>               Runs per request per side. Default 5. Raise it to
                        separate a partial change; 8 is the measured floor.
  --replay              Answer only from recordings. Never calls out, so the
                        run is free and repeats identically.
  --cache <dir>         Where unpacked tarballs live. Defaults outside your
                        project (~/.cache/stantal/npm, or LOCALAPPDATA on
                        Windows) — it is third-party code, not project state.
  --against <version>   check: the published release to compare the build against.
  --current <version>   history: the version you are on now, so the walk can say
                        which release to move to. Default: the oldest walked.
  --since <version>     history: start here instead of the first release.
  --until <version>     history: stop here instead of the latest.
  --concurrency <n>     Calls or fetches in flight at once. Layer 2 defaults to
                        8; a history walk defaults to 4 version fetches.
  --help, --version

Exit codes
  0  clean          nothing a model would read differently
  1  found          a change worth looking at
  2  unreadable     could not read enough to say

The judge is optional and off unless a key is present. It reads
ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY / GOOGLE_API_KEY.
STANTAL_JUDGE forces a provider or "none"; STANTAL_JUDGE_MODEL picks a model.

Layer 2 is separate and off unless --behaviour is passed. It reads the same
keys; STANTAL_CALLER forces a provider or "none", STANTAL_CALLER_MODEL picks a
model. It is not offered on a history walk, where its cost is multiplied by
every release in the range.

Every reply is recorded — .stantal/judge and .stantal/behaviour — and keyed on
the text of the question or request, so a walk over 40 releases asks about an
unchanged parameter once. --replay serves both from disk only and refuses to
call out at all, which is what makes a CI run free. STANTAL_JUDGE_CACHE and
STANTAL_BEHAVIOUR_CACHE do the same per layer; "off" disables a cache.
`.trim();

/**
 * The version, read from the manifest that ships beside `dist`.
 *
 * Read rather than written in. It was hardcoded, and it was already reporting
 * `0.0.0` two releases later — a version string nobody can trust is worse than
 * none, because it is the first thing anyone pastes into a bug report.
 */
function ownVersion(): string {
  try {
    const manifest = new URL("../package.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const version = (parsed as { version?: unknown })?.version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    // Running from an unusual layout. A missing version is not worth failing a
    // command over, and "unknown" is at least honest.
    return "unknown";
  }
}

/**
 * Load a local `.env` if there is one.
 *
 * Best effort and deliberately silent. A key is optional everywhere in this
 * tool, so a missing or malformed file is not a reason to stop — it just means
 * the judge does not run and findings stay unconfirmed. A real environment
 * variable always wins over the file.
 */
function loadDotEnv(): void {
  const load = (process as NodeJS.Process & { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof load !== "function") return; // Node older than 20.12
  try {
    load(".env");
  } catch {
    // No file, or unreadable. Both are normal.
  }
}

// --- Rendering ---------------------------------------------------------------

const useColor =
  process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb" && process.stdout.isTTY === true;

const paint = (code: string, text: string): string => (useColor ? `[${code}m${text}[0m` : text);
const dim = (t: string) => paint("2", t);
const bold = (t: string) => paint("1", t);
const red = (t: string) => paint("31", t);
const yellow = (t: string) => paint("33", t);
const green = (t: string) => paint("32", t);

const VERDICT_COLOR: Record<Report["verdict"], (t: string) => string> = {
  clean: green,
  "prose-risk": yellow,
  "structurally-breaking": red,
  "behaviour-breaking": red,
  unreadable: dim,
};

/** Confidence is shown on every line, because an unconfirmed lead is not a verdict. */
const CONFIDENCE_MARK: Record<string, string> = {
  certain: "confirmed",
  likely: "judged",
  unconfirmed: "unconfirmed",
};

/**
 * Layer 3, rendered.
 *
 * The distinction this has to carry is between "we looked and nothing touches
 * you" and "we could not look properly". A consumer stops reading on the first
 * and must not stop reading on the second, so the two never share a line.
 */
function renderBlast(blast: Report["blast"]): string[] {
  if (blast === null) return [];

  const out: string[] = [""];
  const scanned = dim(`${blast.scanned.files} file(s) scanned`);

  if (blast.reaches.length === 0) {
    out.push(
      canClaimUnaffected(blast)
        ? `  ${green("nothing here reaches your code")}  ${scanned}`
        : `  ${yellow("no reach found, but the scan was incomplete")}  ${scanned}`,
    );
  } else {
    out.push(`  ${bold(`reaches your code in ${blast.reaches.length} place(s)`)}  ${scanned}`);
    for (const reach of blast.reaches.slice(0, 12)) {
      out.push(`    ${reach.kind.padEnd(16)} ${reach.target}`);
      out.push(`      ${dim(`${reach.evidence} — ${reach.detail}`)}`);
    }
    if (blast.reaches.length > 12) {
      out.push(`    ${dim(`... and ${blast.reaches.length - 12} more`)}`);
    }
  }

  // Both of these are claims in their own right, so neither is dropped.
  for (const f of blast.filtered.slice(0, 6)) {
    out.push(`    ${dim(`filtered  ${f.target} — ${f.reason}`)}`);
  }
  for (const note of blast.notes.slice(0, 6)) {
    out.push(`    ${yellow("gap")}  ${dim(`${note.where} — ${note.detail}`)}`);
  }

  return out;
}

function renderSurface(surface: SurfaceReport): string[] {
  const lines: string[] = [];
  const changes = surface.comparison.diff?.changes ?? [];
  const findings = surface.prose.findings;

  const quiet =
    changes.length === 0 &&
    findings.length === 0 &&
    (surface.behaviour?.findings.length ?? 0) === 0 &&
    (surface.behaviour?.skipped.length ?? 0) === 0 &&
    surface.comparison.suppressed.length === 0 &&
    surface.comparison.kind === "compared";
  if (quiet) return lines;

  const tools = isPresent(surface.to) ? surface.to.contract.tools.length : 0;
  lines.push(`  ${bold(surface.subpath)}  ${dim(`${tools} tool(s)`)}`);

  if (surface.comparison.kind !== "compared") {
    lines.push(`    ${dim(surface.comparison.note)}`);
  }

  for (const change of changes) {
    const mark = change.breaking ? red("breaking") : dim("change");
    lines.push(`    ${mark}  ${change.rule}  ${change.target}`);
    lines.push(`      ${dim(change.note)}`);
  }

  for (const finding of findings) {
    const severity = finding.severity === "high" ? red(finding.severity) : yellow(finding.severity);
    lines.push(`    ${severity}  ${finding.rule}  ${finding.target}  ${dim(CONFIDENCE_MARK[finding.confidence] ?? "")}`);
    lines.push(`      ${finding.headline}`);
    if (finding.evidence.quote !== null) {
      lines.push(`      ${dim(`evidence: ${truncate(finding.evidence.quote, 90)}`)}`);
    }
  }

  for (const finding of surface.behaviour?.findings ?? []) {
    const severity = finding.severity === "high" ? red(finding.severity) : yellow(finding.severity);
    // The basis rides next to every one of these. `underpowered` means the runs
    // saw it happen but cannot say how often, and a reader who cannot tell that
    // from a measured rate will over-read the finding.
    lines.push(`    ${severity}  ${finding.rule}  ${finding.target}  ${dim(finding.basis)}`);
    lines.push(`      ${finding.headline}`);
    const ev = finding.evidence;
    lines.push(
      `      ${dim(`before ${ev.before.hits}/${ev.before.runs}  after ${ev.after.hits}/${ev.after.runs}  — "${truncate(ev.intent, 55)}"`)}`,
    );
  }

  // Withheld claims are printed, never dropped. A silent omission would read as
  // a clean bill on something we simply could not see.
  for (const withheld of surface.comparison.suppressed) {
    lines.push(`    ${dim(`withheld  ${withheld.rule}  ${withheld.target} — extraction could not read the whole contract`)}`);
  }
  for (const skipped of surface.prose.skipped) {
    lines.push(`    ${dim(`withheld  ${skipped.target} — ${skipped.reason}`)}`);
  }
  // Layer 2's skips belong here for the same reason as the two loops above. An
  // intent that could not be compared — a replay miss, one side with no runs —
  // leaves no finding, and printing nothing would let an empty behaviour
  // section read as a model having looked and found nothing.
  for (const skipped of surface.behaviour?.skipped ?? []) {
    lines.push(`    ${dim(`withheld  behaviour ${skipped.intentId} — ${skipped.reason}`)}`);
  }

  lines.push("");
  return lines;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function render(report: Report): string {
  const { subject } = report;
  const color = VERDICT_COLOR[report.verdict];
  const out: string[] = [
    "",
    `  ${bold(subject.package)} ${dim("·")} ${subject.from} ${dim("→")} ${subject.to}`,
    "",
    `  ${dim("VERDICT")}  ${color(bold(report.verdict))}`,
    `           ${report.headline}`,
    "",
  ];

  const body = report.surfaces.flatMap(renderSurface);
  if (body.length > 0) out.push(...body);

  if (report.missingDependencies.length > 0) {
    out.push(
      `  ${dim(`could not fetch ${report.missingDependencies.length} dependency/ies; some tool names may be unread`)}`,
      "",
    );
  }

  const judgeNote =
    report.judge === "none"
      ? "no judge configured — semantic findings are unconfirmed leads. Set an API key to confirm them."
      : `judged by ${report.judge}`;
  out.push(`  ${dim(judgeNote)}`);
  // A judge that could not answer is not the same as one that answered
  // nothing. Findings below are unconfirmed leads for a reason the reader
  // cannot otherwise see, and would otherwise read as rule-only by choice.
  const judgeFailed = report.surfaces.map((s) => s.prose.judgeError).find((e) => e !== undefined);
  if (judgeFailed !== undefined) {
    out.push(`  ${yellow("the judge could not answer")}  ${dim(truncate(judgeFailed, 100))}`);
    out.push(`  ${dim("findings stand, unconfirmed — the run was not filtered by a model")}`);
  }
  // Named only once Layer 2 has actually run. Reporting "no caller" on every
  // default run would advertise a layer most people did not ask for.
  if (report.caller !== "none") out.push(`  ${dim(`behaviour replayed on ${report.caller}`)}`);
  out.push(...renderBlast(report.blast));
  out.push(`  ${dim("run with --json for the full report")}`, "");

  return out.join("\n");
}

function renderHistory(result: HistoryResult): string {
  const { summary } = result;
  const first = result.versions[0];
  const last = result.versions[result.versions.length - 1];

  const out: string[] = [
    "",
    `  ${bold(result.package)}  ${dim(`${summary.versionsWalked} releases, ${first} → ${last}`)}`,
    "",
    `  ${dim("FOUND")}  ${bold(String(summary.distinctFindings))} contract change(s) a model would read differently`,
    `         ${summary.silent} of them with no structural signal at all${
      summary.silent > 0 ? red("  ← invisible to every other tool") : ""
    }`,
    `         ${summary.unresolved} still present at ${last}`,
    "",
  ];

  if (result.onsets.length > 0) {
    out.push(`  ${dim("onset — the release that introduced it, and the last one before it")}`, "");
  }

  for (const onset of result.onsets) {
    const severity = onset.severity === "high" ? red(onset.severity) : yellow(onset.severity);
    const span = onset.resolvedAt === null ? `still present` : `fixed in ${onset.resolvedAt}`;
    out.push(
      `  ${severity}  ${onset.rule}  ${bold(onset.target)}  ${dim(onset.subpath)}`,
      `    introduced in ${bold(onset.introducedAt)}${
        onset.lastCleanVersion !== null ? dim(`, last clean ${onset.lastCleanVersion}`) : dim(" (first release walked)")
      }`,
      `    ${dim(`${onset.releasesAffected} release(s) affected, ${span}`)}`,
      `    ${dim(truncate(onset.headline, 96))}`,
      "",
    );
  }

  const unreadable = result.steps.filter((s) => s.unreadableSurfaces.length > 0);
  if (unreadable.length > 0) {
    out.push(
      `  ${dim(`${unreadable.length} release(s) had a surface that could not be read; nothing is claimed about those`)}`,
      "",
    );
  }

  const judgeNote =
    result.judge === "none"
      ? "no judge configured — semantic findings are unconfirmed leads"
      : `judged by ${result.judge}`;
  out.push(`  ${dim(judgeNote)}`, `  ${dim("run with --json for the full walk")}`, "");
  return out.join("\n");
}

/**
 * Where an emitted suite goes when the caller does not say.
 *
 * A directory of our own rather than the project's test folder. Generated files
 * mixed in with hand-written ones get edited by hand and then silently
 * overwritten on the next run, and one lost afternoon is enough for someone to
 * stop using the feature.
 */
const DEFAULT_TEST_DIR = "stantal";

/** Where a restoration goes.  is where patch-package looks. */
const DEFAULT_PATCH_DIR = "patches";

function renderWritten(written: readonly WrittenFile[], pinnedAt: string, resolvable = true): string {
  if (written.length === 0) {
    return [
      ``,
      `  no tests written — nothing here could be pinned`,
      `  a finding earns a test only once its meaning has been checked, and only`,
      `  when the version being pinned really carries what the finding claims`,
      ``,
      ``,
    ].join("\n");
  }

  const lines = [``, `  wrote ${written.length} file(s), pinning ${pinnedAt}`, ``];
  for (const file of written) {
    lines.push(`    ${file.path}`);
    lines.push(`      ${file.assertions} assertion(s)  ${file.subpath}`);
  }
  lines.push(``);
  // Deliberately does not say how to run them. Whether anything here can is a
  // question this cannot answer, and the readiness notes below answer it —
  // telling somebody to "run your test command" when they have none reads as
  // advice from a tool that did not look.
  // Only claimed when this project can actually resolve what they import.
  // Saying "they pass" three lines above a note explaining that nothing here
  // can resolve `vitest` or `stantal` is a false claim, and it was reported by
  // somebody who watched their type-check go from exit 0 to exit 2 right after
  // reading it.
  lines.push(
    resolvable
      ? `  They pass against ${pinnedAt}, and fail when an upgrade takes any of it away.`
      : `  Once the imports below resolve, they pass against ${pinnedAt} and fail when an` +
          `\n  upgrade takes any of it away. Until then nothing here can run or type-check them.`,
  );
  lines.push(``);
  lines.push(``);
  return lines.join("\n");
}

/**
 * Emit contract tests from a comparison.
 *
 * Pins the *older* side. The findings decide what is worth pinning; the older
 * contract decides what may be claimed about it. Both halves are needed — the
 * findings alone would write assertions that were never true, and the contract
 * alone would write hundreds nobody reads.
 */
function emitFromReport(report: Report, out: string | undefined): void {
  const targets: EmitTarget[] = report.surfaces
    .filter((surface) => surface.from.present)
    .map((surface) => ({
      package: report.subject.package,
      subpath: surface.subpath,
      version: report.subject.from,
      // One surface at a time, so an assertion can never be attributed to the
      // wrong door on its way into a filename.
      assertions: assertionsFromReport({ ...report, surfaces: [surface] }),
    }));

  const written = emitTests({
    directory: out ?? DEFAULT_TEST_DIR,
    targets,
    generator: `stantal ${ownVersion()}`,
  });
  process.stdout.write(renderWritten(written, report.subject.from));
}

/** Which provider would settle a judgement call right now, or null for none. */
function judgeName(): string | null {
  const judge = judgeFromEnv();
  return judge === null ? null : judge.id;
}

/**
 * `stantal connect` — put the server where the upgrade decision is made.
 *
 * Writes the MCP entry into a coding agent's project config. The config is a
 * file in the repository, not in the user's home directory: a global config is
 * shared by every project on the machine, and a project file is committable, so
 * one person running this connects the whole team.
 *
 * It does not start anyone's agent unless asked. Spawning a coding agent can
 * edit files and spend tokens, and a tool that does that on install has taken a
 * decision that was not its to take.
 */
function runConnect(
  values: {
    agent?: string | undefined;
    run?: boolean | undefined;
    json?: boolean | undefined;
    directory?: string | undefined;
  },
): number {
  const directory = values.directory ?? process.cwd();
  const version = ownVersion();

  let targets: DetectedAgent[];
  if (values.agent !== undefined) {
    const named = agentById(values.agent);
    if (named === null) {
      process.stderr.write(
        `stantal: unknown agent "${values.agent}". Known: ${AGENTS.map((a) => a.id).join(", ")}\n`,
      );
      return 2;
    }
    targets = [{ agent: named, because: "you named it", strength: "marker" }];
  } else {
    targets = detectAgents(directory);
  }

  if (targets.length === 0) {
    process.stderr.write(
      `stantal: no coding agent detected in ${directory}.\n\n` +
        `Name one directly:\n` +
        AGENTS.map((a) => `  stantal connect --agent ${a.id}\n`).join("") +
        `\nOr skip all of this — the CLI needs no setup at all:\n` +
        `  npx stantal pin <package>\n\n`,
    );
    return 2;
  }

  // Several agents installed on the machine is not several agents used in this
  // project. Writing three config files into a repository that asked for one is
  // clutter somebody has to clean up, so the choice is handed back instead.
  if (targets.length > 1 && targets.every((t) => t.strength === "binary")) {
    process.stderr.write(
      `stantal: found more than one agent on this machine, and nothing in ${directory} says which one
` +
        `this project uses. Name it:

` +
        targets.map((t) => `  stantal connect --agent ${t.agent.id}
`).join("") +
        `
`,
    );
    return 2;
  }

  const installed: InstallResult[] = [];
  for (const { agent } of targets) {
    try {
      installed.push(install({ directory, agent, version }));
    } catch (error) {
      process.stderr.write(`stantal: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }

  // The briefing, written next to the config that makes it actionable.
  //
  // Every agent looks for this file, including ones we do not detect and ones
  // that do not exist yet, so it reaches further than any config we could
  // write. It also travels with the repository: the next person to clone it is
  // briefed without installing anything.
  let briefing: WriteAgentsResult;
  try {
    briefing = writeAgentsMd(directory, version);
  } catch (error) {
    process.stderr.write(`stantal: could not write AGENTS.md: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ directory, version, installed, briefing }, null, 2)}\n`);
    return 0;
  }

  const out: string[] = [""];
  for (let i = 0; i < installed.length; i += 1) {
    const result = installed[i]!;
    const why = targets[i]?.because ?? "";
    out.push(`  ${result.action === "added" ? "connected" : "updated"}  ${result.agent.label}`);
    out.push(`    ${result.file}  — ${why}`);
    if (result.preserved.length > 0) {
      // Said out loud. The reason this is worth printing is that it is the
      // thing a careful person is worried about when a tool edits their config.
      out.push(`    left alone: ${result.preserved.join(", ")}`);
    }
    out.push(`    ${result.agent.next}`);
    out.push("");
  }

  out.push(
    `  ${briefing.action}  ${briefing.file}` +
      (briefing.preserved > 0 ? `  — ${dim(`${briefing.preserved} bytes of yours left alone`)}` : ""),
  );
  out.push(`    ${dim("what your agent reads before it does anything — delete the block to opt out")}`);
  out.push("");

  // Something to read on the first run.
  //
  // Writing the config and stopping leaves nothing visible to show for the
  // command: the agent has to be restarted before any of it does anything, and
  // a first run with no output is one nobody repeats. This is the one question
  // worth answering immediately — of everything installed here, what is even in
  // scope for contract drift. It is a read, not a write.
  const relevant = contractDependencies(directory);
  if (relevant.length === 0) {
    out.push(`  Nothing installed here hands a model a tool contract, so nothing can drift yet.`);
    out.push(`  That is a normal result. Add an MCP server or an agent SDK and run this again.`);
  } else {
    const tools = relevant.reduce((n, d) => n + d.tools, 0);
    out.push(`  ${relevant.length} of your dependencies hand a model a tool contract (${tools} tools):`);
    for (const dep of relevant) {
      out.push(`    ${dep.package}@${dep.version}  ${dep.tools} tool(s)  ${dep.subpaths.join(", ")}`);
    }
    out.push("");
    out.push(`  Ask your agent:  read AGENTS.md and set up stantal`);
  }
  out.push("");
  out.push(`  No account, no key, no signup. Everything above ran on this machine.`);

  // Said here rather than only in a readme. Some findings are judgement calls
  // and are reported as leads when no model is available to settle them.
  // Somebody who never learns that reads "unconfirmed" as "they are not sure
  // this is real", which is close to the opposite of what it means.
  const provider = judgeName();
  if (provider === null) {
    out.push(`  Judgement calls will read "unconfirmed". To have a model settle them, set`);
    out.push(`  ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY. Your key, your bill.`);
  } else {
    out.push(`  Judgement calls will be settled by ${provider}.`);
  }
  out.push("");
  process.stdout.write(out.join("\n"));

  if (values.run !== true) return 0;

  // Only past an explicit flag. Even then it is the user's own agent, running
  // with its own approval prompts intact.
  for (const { agent } of targets) {
    const result = runAgent(agent, directory);
    process.stdout.write(`  ${result.detail}\n`);
    if (result.ran) return 0;
  }
  return 0;
}

/**
 * Send a verdict somewhere it can be linked to.
 *
 * The only thing this tool does that sends anything anywhere, and it happens
 * only when a flag asks for it. Two consequences are handled here rather than
 * in the host, because a promise kept by somebody else's server is not a
 * promise:
 *
 * 1. **Layer 3's result never leaves.** It carries paths and line numbers out
 *    of the user's own repository. A verdict is meant to be forwarded to the
 *    package's author, who has no business seeing the shape of a codebase that
 *    is not theirs.
 * 2. **What was removed is printed.** A silent strip is indistinguishable from
 *    a leak to anyone reading the output, and the person deciding whether to
 *    send this is the one who needs to know.
 */
async function publishVerdict(report: Report, host: string): Promise<void> {
  const { report: safe, stripped } = publishableReport(report);
  const endpoint = `${host.replace(/\/+$/, "")}/v`;

  for (const item of stripped) {
    process.stdout.write(`  removed before sending: ${item.detail}\n`);
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report: safe }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        body !== null && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "";
      process.stderr.write(`stantal: could not publish (${response.status}) ${detail}\n`);
      return;
    }
    const url = body !== null && typeof body === "object" && "url" in body ? String((body as { url: unknown }).url) : "";
    process.stdout.write(`  published: ${url}\n\n`);
  } catch (error) {
    // Never fatal. The verdict has already been printed and it is the product's
    // answer; losing the exit code because a host was unreachable would replace
    // a real result with an unrelated one.
    process.stderr.write(
      `stantal: could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Where to publish, if anywhere.
 *
 * There is no built-in default on purpose. A flag that quietly sends a report
 * to an address the user never typed is the kind of thing this project exists
 * to object to when other people do it.
 */
function verdictHost(values: { publish?: string | undefined }): string | null {
  const named = values.publish;
  if (named !== undefined && named.length > 0) return named;
  const fromEnv = process.env["STANTAL_VERDICT_HOST"];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : null;
}

/**
 * Write the verdict as a page, and say where it went.
 *
 * A failure to write it is reported and never fatal. The verdict is the
 * product's answer and it has already been printed; losing the exit code over
 * a full disk or a bad path would replace a real result with an unrelated one.
 */
function writeHtmlVerdict(report: Report, path: string): void {
  try {
    writeFileSync(path, renderHtml({ report, generator: `stantal ${ownVersion()}` }), "utf8");
    process.stdout.write(`  verdict written to ${path}\n\n`);
  } catch (error) {
    process.stderr.write(
      `stantal: could not write ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * `stantal patch <package> <from>` — put the deleted prose back.
 *
 * The `patch` remedy from Layer 4, made real. When every published release
 * carries the defect there is nowhere to upgrade to, and the calling code was
 * never wrong — the wrong bytes are in `node_modules`. Restoring them is the
 * only thing that actually works.
 *
 * The version on disk is the newer side. Asking for it separately would let the
 * two disagree, and a patch computed against a version that is not installed is
 * a patch that corrupts a file.
 *
 * Only prose is ever restored. A description cannot break a caller, because no
 * caller branches on one — only a model reads it, which is this project's whole
 * premise. Schemas, types and required flags are never touched.
 */
async function runPatch(
  pkg: string | undefined,
  from: string | undefined,
  values: {
    json?: boolean | undefined;
    apply?: boolean | undefined;
    surface?: string[] | undefined;
    cache?: string | undefined;
    "emit-patch"?: boolean | undefined;
    directory?: string | undefined;
    out?: string | undefined;
  },
  judge: Judge | null,
): Promise<number> {
  if (pkg === undefined || from === undefined) {
    process.stderr.write(
      `stantal: patch wants a package and the version whose prose you want back.\n\n` +
        `  stantal patch @scope/example-sdk 1.4.0\n\n`,
    );
    return 2;
  }

  const root = values.directory ?? process.cwd();
  const directory = packageDirectory(pkg, root);
  if (directory === null) {
    process.stderr.write(
      `stantal: ${pkg} is not installed under any node_modules above ${root}.\n` +
        `A patch edits the copy you actually run, so there has to be one.\n`,
    );
    return 2;
  }

  const manifest = fsPackageSource(directory).packageJson();
  const installed = manifest !== null && typeof manifest["version"] === "string" ? manifest["version"] : null;
  if (installed === null) {
    process.stderr.write(`stantal: cannot read a version from ${directory}/package.json\n`);
    return 2;
  }
  if (installed === from) {
    process.stderr.write(
      `stantal: ${pkg}@${from} is what is installed, so there is nothing to restore.\n` +
        `Name the version whose prose you want back, not the one you are on.\n`,
    );
    return 2;
  }

  try {
    const report = await buildReport({
      package: pkg,
      from,
      to: installed,
      registry: pacoteRegistry(),
      judge,
      ...(values.cache !== undefined ? { cacheRoot: values.cache } : {}),
      ...(values.surface !== undefined ? { subpaths: values.surface } : {}),
    });

    const plan = planPatch({ report, packageDir: directory, version: installed });

    if (values.json === true) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return canApply(plan) ? 0 : 1;
    }

    const out: string[] = ["", `  ${pkg}@${installed}  restoring prose from ${from}`, ""];

    if (!canApply(plan)) {
      out.push(`  nothing to restore`);
      for (const refusal of plan.refused) {
        out.push(`    ${refusal.tool}  ${refusal.reason} — ${refusal.detail}`);
      }
      out.push("");
      process.stdout.write(out.join("\n") + "\n");
      return 1;
    }

    for (const edit of plan.edits) {
      out.push(`    ${edit.tool}  ${edit.subpath}`);
      out.push(`      ${edit.file}  (${edit.encoding})`);
      out.push(`      ${edit.why}`);
    }
    if (plan.refused.length > 0) {
      out.push("", `  declined ${plan.refused.length}:`);
      for (const refusal of plan.refused) {
        out.push(`    ${refusal.tool}  ${refusal.reason} — ${refusal.detail}`);
      }
    }
    out.push("");

    // The durable half. `--apply` edits node_modules, which is the right way to
    // check a restoration and is erased by the next install. This writes the
    // same edits as a patch file that lives in the repository, is reviewable as
    // a diff, and is reapplied on every install by patch-package.
    let emitted: string | null = null;
    if (values["emit-patch"] === true) {
      const rendered = renderPatchFile(plan, directory);
      if (rendered === null) {
        out.push(`  no patch written — none of the planned edits could be rendered against the files on disk`);
        out.push("");
        process.stdout.write(out.join("\n") + "\n");
        return 1;
      }
      const patchDir = join(root, values.out ?? DEFAULT_PATCH_DIR);
      emitted = join(patchDir, rendered.name);
      mkdirSync(patchDir, { recursive: true });
      writeFileSync(emitted, rendered.text, "utf8");

      out.push(`  wrote ${rendered.name}  ${dim(`${rendered.files.length} file(s)`)}`);
      out.push(`    ${emitted}`);
      out.push("");
      out.push(`  It is a plain diff — read it before you commit it.`);
      // Named rather than assumed. The file alone changes nothing; something
      // has to reapply it after each install, and if that step is skipped the
      // restoration disappears exactly as quietly as the sentence it restores.
      if (packageDirectory("patch-package", root) === null) {
        out.push(`  Nothing here reapplies it yet:`);
        out.push(`      npm install -D patch-package`);
        out.push(`      npm pkg set scripts.postinstall="patch-package"`);
      } else {
        out.push(`  patch-package is installed, so this reapplies on every install.`);
      }
      out.push("");
    }

    if (values.apply !== true) {
      // Printed, never written into the dependency unless asked. Editing
      // somebody's node_modules is a side effect nobody should get from a
      // command they ran to look at something.
      out.push(
        emitted === null
          ? `  nothing was written — re-run with --emit-patch to keep these, or --apply to edit node_modules`
          : `  node_modules was left alone — add --apply to also edit it in place now`,
      );
      out.push("");
      process.stdout.write(out.join("\n") + "\n");
      return emitted === null ? 1 : 0;
    }

    const results = applyPatch(plan, directory);
    for (const result of results) {
      out.push(`  ${result.applied ? "patched" : "skipped"}  ${result.file} — ${result.detail}`);
    }
    out.push("");
    // A fresh `npm install` throws this away. Saying so is the difference
    // between a fix and a fix that silently disappears on the next CI run.
    out.push(`  node_modules is not durable. Make it stick with:`);
    out.push(`    npx patch-package ${pkg}`);
    out.push("");
    process.stdout.write(out.join("\n") + "\n");
    return results.some((r) => r.applied) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`stantal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/**
 * `stantal pin` — one package, or every one that needs it.
 *
 * `--all` exists because the single-package form asks the user to already know
 * which of their dependencies hand a model tools, and that is the one thing
 * they have no way to know before running something. The audit names them; this
 * protects all of them in one command.
 *
 * **`--all` never overwrites an existing suite.** A package pinned at 1.0 and
 * upgraded to 1.1 would be re-recorded against 1.1, which erases the assertions
 * that were about to fail and reports it as success — the tool quietly deleting
 * the protection it was run to provide. A package already pinned is skipped and
 * said out loud. Refreshing one on purpose is still `stantal pin <package>`.
 */
function runPin(
  pkg: string | undefined,
  values: {
    surface?: string[] | undefined;
    out?: string | undefined;
    json?: boolean | undefined;
    all?: boolean | undefined;
    directory?: string | undefined;
  },
): number {
  const root = values.directory ?? process.cwd();
  if (values.all !== true) return pinOne(pkg, values, root);

  if (pkg !== undefined) {
    process.stderr.write(`stantal: pin takes a package name or --all, not both.\n`);
    return 2;
  }

  const testDir = values.out ?? DEFAULT_TEST_DIR;
  const deps = contractDependencies(root);

  if (deps.length === 0) {
    process.stderr.write(
      `stantal: no installed dependency in ${root} exposes a tool contract to pin.\n` +
        `That is a normal result. It is not a claim that every dependency was readable.\n`,
    );
    return 0;
  }

  const already: string[] = [];
  const attempted: string[] = [];
  let failures = 0;

  for (const dep of deps) {
    const pinned = dep.subpaths.every((subpath) =>
      existsSync(join(root, testDir, testFileName(dep.package, subpath))),
    );
    if (pinned) {
      already.push(dep.package);
      continue;
    }
    attempted.push(dep.package);
    if (pinOne(dep.package, values, root) !== 0) failures += 1;
  }

  if (already.length > 0) {
    process.stdout.write(
      `\n  already pinned, left alone: ${already.join(", ")}\n` +
        `    ${dim(`re-record one against the version installed now with: stantal pin <package>`)}\n`,
    );
  }

  // Counted against what was attempted, not against every dependency. "0 of 2
  // pinned" is what this said when both were already protected, which reads as
  // a failure and is the opposite of what happened.
  process.stdout.write(
    attempted.length === 0
      ? `\n  ${bold(`nothing left to pin`)}  ${dim(`all ${deps.length} package(s) already have contract tests`)}\n\n`
      : `\n  ${bold(`${attempted.length - failures} of ${attempted.length} package(s) pinned`)}` +
          `${failures > 0 ? red(`, ${failures} could not be read`) : ""}` +
          `${already.length > 0 ? dim(`, ${already.length} already had tests`) : ""}\n\n`,
  );

  // Nothing written and nothing already in place is a failure to do the job.
  // Exiting 0 there would let a setup step pass while protecting nothing.
  return attempted.length > 0 && attempted.length === failures ? 2 : 0;
}

/**
 * `stantal pin <package>` — write contract tests for what is installed now.
 *
 * The only command here that writes into the user's repository, and the only
 * one that needs no second version, no registry and no network. It reads what
 * is installed, records what the package offers, and leaves behind a suite that
 * fails the day a release quietly drops any of it.
 *
 * Deliberately not a comparison. Most people who should run this have not hit a
 * problem yet and have no second version in mind, and asking for one would make
 * the safe move the harder one.
 */
function pinOne(
  pkg: string | undefined,
  values: {
    surface?: string[] | undefined;
    out?: string | undefined;
    json?: boolean | undefined;
  },
  // The project being written into, as distinct from the package being read.
  // Passed rather than read back off the process, so that scanning one
  // directory and writing into another is impossible rather than unlikely.
  root: string,
): number {
  if (pkg === undefined) {
    process.stderr.write(`stantal: pin wants a package name.\n\n  stantal pin @scope/example-sdk\n\n`);
    return 2;
  }

  const directory = packageDirectory(pkg, root);
  if (directory === null) {
    process.stderr.write(
      `stantal: ${pkg} is not installed under any node_modules above ${root}.\n` +
        `Contract tests pin the version you actually run, so install it first.\n`,
    );
    return 2;
  }

  const source = fsPackageSource(directory);
  const manifest = source.packageJson();
  if (manifest === null) {
    process.stderr.write(`stantal: ${directory} has no readable package.json\n`);
    return 2;
  }

  const version = typeof manifest["version"] === "string" ? manifest["version"] : "unknown";
  const subpaths = values.surface ?? exportedSubpaths(manifest);

  const targets: EmitTarget[] = [];
  // Two different results, kept apart. "This entry point ships no tools" is a
  // fact about the package; "we could not read it" is a gap in our reading, and
  // only the second leaves something unprotected. Reporting them in one list
  // told a user their UI entry point was fine when it was the one surface we
  // had failed on.
  const empty: string[] = [];
  const unreadable: Array<{ subpath: string; detail: string; evidence: string | null }> = [];
  for (const subpath of subpaths) {
    const result = extractFromModule({ package: pkg, version, subpath, source });
    if (!result.present) {
      if (isEvidencedAbsence(result.absence.reason)) {
        empty.push(subpath);
      } else {
        unreadable.push({
          subpath,
          detail: result.absence.detail,
          evidence: result.absence.checked[0] ?? null,
        });
      }
      continue;
    }
    targets.push({
      package: pkg,
      subpath,
      version,
      assertions: assertionsFromContract(result.contract, subpath, result.notes),
    });
  }

  const written = emitTests({
    directory: join(root, values.out ?? DEFAULT_TEST_DIR),
    targets,
    generator: `stantal ${ownVersion()}`,
  });

  // Whether this repository can resolve what the generated files import, and
  // whether anything here would ever run them. Checked after writing rather
  // than before, because the answer is advice rather than a veto — the files
  // were asked for.
  // The suite is written; now make something able to run it. Done before
  // readiness is measured, because adding the script is exactly what changes
  // the answer to "can anything here run these". Skipped when nothing was
  // written, so a run that pinned nothing changes no files at all.
  const runner =
    written.length > 0
      ? setupRunner({ root, testDir: values.out ?? DEFAULT_TEST_DIR, generator: `stantal ${ownVersion()}` })
      : null;

  const readiness = hostReadiness(root);

  if (values.json === true) {
    process.stdout.write(
      `${JSON.stringify({ package: pkg, version, written, empty, unreadable, readiness, runner }, null, 2)}\n`,
    );
    return written.length === 0 ? 2 : 0;
  }

  process.stdout.write(`\n  ${pkg}@${version}\n`);
  process.stdout.write(renderWritten(written, `${pkg}@${version}`, readiness.missing.length === 0));

  if (runner !== null) {
    if (runner.config !== null || runner.script) {
      const parts: string[] = [];
      if (runner.config !== null) parts.push(runner.config);
      if (runner.script) parts.push(`the ${CONTRACT_SCRIPT} script`);
      process.stdout.write(`  also wrote ${parts.join(" and ")}\n`);
      process.stdout.write(`    ${dim(`run them with: npm run ${CONTRACT_SCRIPT}`)}\n\n`);
    }
    for (const note of runner.notes) process.stdout.write(`    ${dim(note)}\n`);
  }

  const notes = readinessNotes(readiness, root);
  if (notes.length > 0) {
    process.stdout.write(`  BEFORE THESE DO ANYTHING\n`);
    for (const line of notes) process.stdout.write(line.length === 0 ? "\n" : `    ${line}\n`);
    process.stdout.write("\n");
  }

  if (empty.length > 0) {
    process.stdout.write(`  nothing to pin at: ${empty.join(", ")}\n`);
    process.stdout.write(`    those entry points ship no tools, so there is nothing to protect\n\n`);
  }

  if (unreadable.length > 0) {
    process.stdout.write(`  COULD NOT READ ${unreadable.length} entry point(s) — left unprotected:\n`);
    for (const gap of unreadable) {
      process.stdout.write(`    ${gap.subpath}  ${gap.detail}\n`);
      if (gap.evidence !== null) process.stdout.write(`      ${gap.evidence}\n`);
    }
    process.stdout.write(`    This is a gap in our reading, not proof they ship nothing.\n\n`);
  }

  // Nothing written and nothing readable is a failure to do the job, not a
  // clean result. Exiting 0 here would let a CI step that pins a package pass
  // while protecting nothing at all.
  return written.length === 0 ? 2 : 0;
}

/**
 * The provider's gate: a build on disk against a release already out there.
 *
 * The one question neither other entry point could answer. Comparing two
 * published versions is too late — the release is already out — and the
 * manifest path needs a contract serialized to JSON, which a host produces and
 * an ordinary npm package does not.
 */
async function runCheck(
  directory: string | undefined,
  values: {
    json?: boolean | undefined;
    html?: string | undefined;
    publish?: string | undefined;
    against?: string | undefined;
    surface?: string[] | undefined;
    cache?: string | undefined;
    name?: string | undefined;
  },
  judge: Judge | null,
  behaviour: BehaviourOptions | undefined,
  repo: ReturnType<typeof fsRepoSource> | undefined,
): Promise<number> {
  if (directory === undefined || values.against === undefined) {
    process.stderr.write(
      `stantal: check wants a directory and --against <version>.\n\n  stantal check ./ --against 1.4.0\n\n`,
    );
    return 2;
  }

  // The package name comes from the build's own manifest. Asking for it
  // separately would let the two disagree, and a report labelled with the wrong
  // package is worse than no report.
  let pkg = values.name;
  if (pkg === undefined) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
      const name = (parsed as { name?: unknown })?.name;
      if (typeof name !== "string") throw new Error("package.json has no name");
      pkg = name;
    } catch (error) {
      process.stderr.write(
        `stantal: cannot read ${directory}/package.json: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }

  try {
    const report = await buildLocalReport({
      directory,
      against: { package: pkg, version: values.against, registry: pacoteRegistry() },
      judge,
      ...(behaviour === undefined ? {} : { behaviour }),
      ...(values.cache !== undefined ? { cacheRoot: values.cache } : {}),
      ...(values.surface !== undefined ? { subpaths: values.surface } : {}),
      ...(repo === undefined ? {} : { repo }),
    });

    process.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    if (values.html !== undefined) writeHtmlVerdict(report, values.html);
    const host = verdictHost(values);
    if (host !== null) await publishVerdict(report, host);
    return exitCodeFor(report.verdict);
  } catch (error) {
    process.stderr.write(`stantal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/**
 * Compare two serialized tool manifests.
 *
 * The provider's side of the product. Nothing is fetched, so this is the only
 * path that works on a release that does not exist publicly — which is the
 * normal case for the person deciding whether to ship it.
 */
async function runManifest(
  beforePath: string | undefined,
  afterPath: string | undefined,
  values: {
    json?: boolean | undefined;
    name?: string | undefined;
    surface?: string[] | undefined;
    html?: string | undefined;
    publish?: string | undefined;
    "fields-at"?: string | undefined;
    "exclude-when"?: string[] | undefined;
  },
  judge: Judge | null,
  behaviour: BehaviourOptions | undefined,
  repo: RepoSource | undefined,
): Promise<number> {
  if (beforePath === undefined || afterPath === undefined) {
    process.stderr.write(`stantal: manifest needs two files — a before and an after.\n\n${USAGE}\n`);
    return 2;
  }

  // Said out loud rather than dropped. A manifest is one door — the file — so
  // there is no subpath to select, and a user who passed `--surface` expecting
  // it to narrow the read should not have to infer from the output that it did
  // nothing.
  if (values.surface !== undefined) {
    process.stderr.write("stantal: --surface does not apply to a manifest, and was ignored.\n");
  }

  // Each side may name several documents, catalog first. A contract split
  // across files is ordinary — schemas generated from routes, prose kept where
  // a person edits it — and reading only the first would report real schemas
  // beside descriptions that were never shipped.
  const sides: Array<{ version: string; sources: Array<{ text: string; origin: string }> }> = [];
  for (const spec of [beforePath, afterPath]) {
    const paths = spec.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (paths.length === 0) {
      process.stderr.write(`stantal: "${spec}" names no file.\n`);
      return 2;
    }

    const sources: Array<{ text: string; origin: string }> = [];
    for (const path of paths) {
      try {
        sources.push({ text: readFileSync(path, "utf8"), origin: basename(path) });
      } catch (error) {
        // Exit 2, never a verdict. A file we could not open is a gap in the
        // reading, and "clean" would be a claim we have no basis for.
        process.stderr.write(
          `stantal: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 2;
      }
    }
    sides.push({ version: spec, sources });
  }
  const [from, to] = sides as [(typeof sides)[number], (typeof sides)[number]];

  const excludeWhen: Array<{ key: string; value: string }> = [];
  for (const rule of values["exclude-when"] ?? []) {
    const at = rule.indexOf("=");
    if (at <= 0) {
      process.stderr.write(`stantal: --exclude-when wants key=value, got "${rule}"\n`);
      return 2;
    }
    excludeWhen.push({ key: rule.slice(0, at), value: rule.slice(at + 1) });
  }

  try {
    const report = await buildManifestReport({
      from,
      to,
      package: values.name ?? basename(afterPath.split(",")[0] ?? afterPath),
      judge,
      ...(values["fields-at"] !== undefined ? { fieldsKey: values["fields-at"] } : {}),
      ...(excludeWhen.length > 0 ? { excludeWhen } : {}),
      ...(repo === undefined ? {} : { repo }),
      ...(behaviour === undefined ? {} : { behaviour }),
    });

    process.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    if (values.html !== undefined) writeHtmlVerdict(report, values.html);
    const host = verdictHost(values);
    if (host !== null) await publishVerdict(report, host);
    return exitCodeFor(report.verdict);
  } catch (error) {
    process.stderr.write(`stantal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/**
 * Layer 4, rendered.
 *
 * The one section a reader acts on, so it says the version to move to and the
 * one they would otherwise have reached for. "Upgrade to the latest" is the
 * advice everyone already gives and nobody takes; the useful number is the
 * smallest hop that clears the reason they are stuck.
 */
function renderRemedy(remedy: Remedy): string {
  const out: string[] = [""];

  const label: Record<Remedy["kind"], (t: string) => string> = {
    stay: green,
    upgrade: green,
    migrate: yellow,
    stuck: red,
    patch: red,
    fix_locally: yellow,
    unknown: dim,
  };

  out.push(`  ${bold("WHAT TO DO")}  ${label[remedy.kind](remedy.kind.replace("_", " "))}`);
  out.push(`           ${remedy.headline}`);

  if (remedy.target !== null) {
    out.push("", `    move to  ${bold(remedy.target)}`);
    if (remedy.latest !== null && remedy.latest !== remedy.target) {
      // Shown side by side on purpose: the gap between the two is the whole
      // argument for not simply taking the newest release.
      out.push(`    latest   ${dim(remedy.latest)}  ${dim("— more change than you asked for")}`);
    }
  }

  if (remedy.hold !== undefined) {
    // A pin nobody revisits is how a consumer gets stranded in the first place,
    // so the reason is printed as something re-checkable rather than a note to
    // self.
    out.push("", `    ${dim(`held at ${remedy.hold.heldAt} until these clear (still present at ${remedy.hold.stillPresentAt}):`)}`);
    for (const u of remedy.hold.until.slice(0, 6)) {
      out.push(`      ${u.rule}  ${u.target}  ${dim(u.subpath)}`);
    }
    if (remedy.hold.until.length > 6) {
      out.push(`      ${dim(`... and ${remedy.hold.until.length - 6} more`)}`);
    }
  }

  if (remedy.unverifiable.length > 0) {
    // A release skipped because it could not be read is not a release that was
    // considered and rejected, and the reader may want to look themselves.
    out.push(
      "",
      `    ${yellow("not verifiable")}  ${dim(`${remedy.unverifiable.length} release(s) could not be read well enough to call clean: ${remedy.unverifiable.slice(0, 5).join(", ")}`)}`,
    );
  }

  out.push("");
  return out.join("\n");
}

async function runHistory(
  pkg: string | undefined,
  values: {
    json?: boolean | undefined;
    cache?: string | undefined;
    since?: string | undefined;
    until?: string | undefined;
    concurrency?: string | undefined;
    surface?: string[] | undefined;
    current?: string | undefined;
  },
  judge: ReturnType<typeof judgeFromEnv>,
): Promise<number> {
  if (pkg === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const quiet = values.json === true;
  try {
    const result = await walkHistory({
      package: pkg,
      registry: pacoteRegistry(),
      judge,
      ...(values.cache !== undefined ? { cacheRoot: values.cache } : {}),
      ...(values.since !== undefined ? { since: values.since } : {}),
      ...(values.until !== undefined ? { until: values.until } : {}),
      ...(values.surface !== undefined ? { subpaths: values.surface } : {}),
      ...(values.concurrency !== undefined ? { concurrency: Number(values.concurrency) } : {}),
      // Progress goes to stderr so `--json` stays pipeable.
      ...(quiet
        ? {}
        : {
            onProgress: (done: number, total: number, version: string) => {
              process.stderr.write(`\r  reading ${done}/${total}  ${version}${" ".repeat(12)}`);
              if (done === total) process.stderr.write(`\r${" ".repeat(48)}\r`);
            },
          }),
    });

    // Layer 4 reads the completed walk and decides. Every fact it needs was
    // already measured, so it costs nothing and never calls out.
    const remedy = planRemedy({
      walk: result,
      ...(values.current === undefined ? {} : { current: values.current }),
    });

    process.stdout.write(
      quiet
        ? `${JSON.stringify({ ...result, remedy }, null, 2)}\n`
        : renderHistory(result) + renderRemedy(remedy),
    );
    return result.summary.distinctFindings > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`stantal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/**
 * What `--replay` has to mean, in one place.
 *
 * The flag promises the run cannot spend, and that promise has to cover every
 * layer that calls out — not only the one that existed when the flag was
 * written. Setting the judge's cache alone would leave Layer 2 free to spend on
 * a run the user was told was free, which is worse than not offering the flag.
 */
/**
 * Say which door a gemini run is going through, because they bill differently.
 *
 * The two endpoints serve the same models. AI Studio
 * (`generativelanguage.googleapis.com`, an API key) is billed on its own and is
 * **not** covered by Google Cloud credits; Vertex
 * (`aiplatform.googleapis.com`, an OAuth token) is billed to a cloud project
 * and is. So an unset `STANTAL_VERTEX_PROJECT` is not a smaller or slower run —
 * it is the same run charged to a card instead of to credits that are sitting
 * unused, and nothing in the output would otherwise say so.
 *
 * A warning rather than a refusal: plenty of people have no cloud project and
 * an API key is the supported way to run. The failure worth preventing is
 * silent, not deliberate.
 */
export function warnIfGeminiBillsACard(
  id: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  write: (s: string) => void = (s) => void process.stderr.write(s),
): void {
  if (id === undefined || !id.startsWith("gemini:")) return;
  if (vertexFromEnv(env) !== null) return;
  write(
    `stantal: ${id} is going through AI Studio, which is billed separately from
Google Cloud credits. Set STANTAL_VERTEX_PROJECT=<project> to route the same
model through Vertex AI and draw on those credits instead.
`,
  );
}

export function applyReplay(env: NodeJS.ProcessEnv): void {
  env["STANTAL_JUDGE_CACHE"] = "replay";
  env["STANTAL_BEHAVIOUR_CACHE"] = "replay";
}

// --- The no-argument command -------------------------------------------------

/**
 * `npx stantal`, with nothing after it.
 *
 * The other commands all assume the user already knows a package name and two
 * versions. Almost nobody does before something has broken. This one starts
 * from the only thing they reliably have — a directory — and ends with a short
 * list of things to do, in order.
 *
 * **It writes nothing.** The plan names `stantal pin --all` as a step; that
 * command is the one that writes, and it runs because somebody ran it.
 */
async function runAudit(
  values: {
    json?: boolean | undefined;
    cache?: string | undefined;
    directory?: string | undefined;
    concurrency?: number | undefined;
    repo?: RepoSource | undefined;
    out?: string | undefined;
  },
  judge: Judge | null,
): Promise<number> {
  const directory = values.directory ?? process.cwd();
  const quiet = values.json === true;

  // Progress on stderr, never stdout. `--json` has to stay pipeable, and a
  // progress line in the middle of a JSON document is the kind of small
  // thoughtlessness that makes a tool unusable in a script.
  if (!quiet) process.stderr.write(`  reading ${directory}\n`);

  const result = await auditProject({
    directory,
    registry: pacoteRegistry(),
    judge,
    ...(values.repo === undefined ? {} : { repo: values.repo }),
    ...(values.cache !== undefined ? { cacheRoot: values.cache } : {}),
    ...(values.out !== undefined ? { testDir: values.out } : {}),
    ...(values.concurrency !== undefined ? { concurrency: values.concurrency } : {}),
    ...(quiet
      ? {}
      : {
          onProgress: (done, total, pkg) => {
            process.stderr.write(`  [${done}/${total}] ${pkg}\n`);
          },
        }),
  });

  const verdict = auditVerdict(result);

  if (quiet) {
    process.stdout.write(`${JSON.stringify({ verdict, ...result }, null, 2)}\n`);
  } else {
    process.stdout.write(renderAudit(result, verdict));
  }

  // `nothing-to-check` is a clean exit, not a failure. A repository with no
  // contract-bearing dependency genuinely has nothing here that can go wrong,
  // and a non-zero exit would teach people to stop running this in CI.
  return verdict === "nothing-to-check" ? 0 : exitCodeFor(verdict);
}

function renderAudit(result: AuditResult, verdict: ReturnType<typeof auditVerdict>): string {
  const out: string[] = ["", `  ${bold("stantal")}  ${dim(result.directory)}`, ""];

  if (result.entries.length === 0) {
    out.push(
      `  ${dim(`${result.declared} dependency/ies, none of which hand a model tools`)}`,
      "",
      `  ${green("Nothing here can be affected by contract drift.")}`,
      `  ${dim("A normal result. It is not a claim that every dependency was readable.")}`,
      "",
    );
    return out.join("\n");
  }

  const color = verdict === "nothing-to-check" ? green : VERDICT_COLOR[verdict];
  out.push(
    `  ${bold(String(result.declared))} dependencies ${dim("·")} ${bold(
      String(result.entries.length),
    )} hand a model tools`,
    `  ${dim("VERDICT")}  ${color(bold(verdict))}`,
    "",
  );

  for (const entry of result.entries) out.push(...renderAuditEntry(entry));

  const steps = nextSteps(result);
  if (steps.length > 0) {
    out.push(`  ${bold("DO THIS")}`);
    steps.forEach((step, index) => {
      out.push(`    ${index + 1}. ${step.action}`);
      if (step.why !== null) out.push(`       ${dim(step.why)}`);
    });
    out.push("");
  }

  return out.join("\n");
}

function renderAuditEntry(entry: AuditEntry): string[] {
  const out: string[] = [];
  const move =
    entry.latest === null
      ? dim("could not resolve the latest release")
      : isCurrent(entry)
        ? `${entry.installed}  ${dim("current")}`
        : `${entry.installed} ${dim("→")} ${bold(entry.latest)}`;

  out.push(`  ${bold(entry.package)}  ${move}`);

  if (entry.report !== null) {
    const counts = countFindings(entry.report);
    const total = counts.structural + counts.prose + counts.behavioural;
    const paint = VERDICT_COLOR[entry.report.verdict];
    out.push(`    ${paint(entry.report.verdict)}  ${dim(truncate(entry.report.headline, 88))}`);

    const blast = entry.report.blast;
    if (blast !== null && blast.reaches.length > 0) {
      const first = blast.reaches[0];
      const more = blast.reaches.length - 1;
      out.push(
        `    ${red(`reaches your code in ${blast.reaches.length} place(s)`)}  ${dim(
          `${first?.evidence}${more > 0 ? ` and ${more} more` : ""}`,
        )}`,
      );
    } else if (heldByRange(entry)) {
      // The narrower, more useful version of "does not reach you": it does not
      // reach you *yet*, and the thing keeping it out is a line you control.
      out.push(
        `    ${green("your declared range already excludes this")}  ${dim(
          `${total} finding(s) in the package, none admitted`,
        )}`,
      );
    } else if (blast !== null && canClaimUnaffected(blast)) {
      out.push(`    ${green("nothing here reaches your code")}  ${dim(`${total} finding(s) in the package`)}`);
    }
  } else if (entry.note !== null) {
    // An unreachable dependency is painted like a gap, never like a pass. This
    // is the line where a silent failure would otherwise read as good news.
    out.push(isUnreachable(entry) ? `    ${yellow("gap")}  ${dim(entry.note)}` : `    ${dim(entry.note)}`);
  }

  const unpinned = entry.subpaths.length - entry.pinnedSubpaths.length;
  out.push(
    unpinned === 0
      ? `    ${dim(`${entry.tools} tool(s) pinned by contract tests`)}`
      : `    ${dim(`${entry.tools} tool(s) across ${unpinned} unpinned entry point(s)`)}`,
  );
  out.push("");
  return out;
}

type NextStep = { action: string; why: string | null };

/**
 * The ordered list at the bottom, which is the only part most people read.
 *
 * Ordered by what blocks what, not by severity. A test runner comes first
 * because without one every later step writes files nothing will ever execute
 * — and a suite nobody runs is worse than no suite, because it reads like
 * protection.
 */
function nextSteps(result: AuditResult): NextStep[] {
  const steps: NextStep[] = [];

  if (result.readiness.missing.length > 0) {
    steps.push({
      action: `npm install -D ${result.readiness.missing.join(" ")}`,
      why: "the contract tests import these, and nothing here can resolve them yet",
    });
  } else if (!result.readiness.hasRunner) {
    steps.push({
      action: "npm install -D vitest",
      why: "nothing in this project can run a test suite, so nothing would run these either",
    });
  }

  const unpinned = result.entries.filter((e) => e.pinnedSubpaths.length < e.subpaths.length);
  if (unpinned.length > 0) {
    const tools = unpinned.reduce((n, e) => n + e.tools, 0);
    steps.push({
      action: "stantal pin --all",
      why: `writes contract tests for ${tools} tool(s) across ${unpinned.length} package(s), so the next upgrade fails a test instead of a customer`,
    });
  }

  for (const entry of result.entries) {
    if (entry.report === null || entry.latest === null) continue;
    if (entry.report.verdict === "clean") continue;
    if (entry.report.verdict === "unreadable") {
      steps.push({
        action: `stantal ${entry.package} ${entry.installed} ${entry.latest}`,
        why: "we could not read enough of this pair to clear it — look before taking the upgrade",
      });
      continue;
    }
    if (heldByRange(entry)) {
      // Nothing to do, and saying so is the point. This is the one entry where
      // the general advice would be wrong.
      steps.push({
        action: `leave ${entry.package} alone — your range already excludes ${entry.latest}`,
        why: "widening it is what would take the change, so do that deliberately rather than by habit",
      });
      continue;
    }

    const reaches = reachCount(entry);
    steps.push({
      action: `hold ${entry.package} at ${entry.installed}`,
      why:
        reaches > 0
          ? `${entry.latest} changes what a model reads, in ${reaches} place(s) this repository touches`
          : `${entry.latest} changes what a model reads — see: stantal ${entry.package} ${entry.installed} ${entry.latest}`,
    });
  }

  for (const entry of result.entries) {
    if (!isUnreachable(entry)) continue;
    steps.push({
      action: `re-run when the registry is reachable — ${entry.package} was not checked`,
      why: "nothing is claimed about a dependency we could not read",
    });
  }

  return steps;
}

/**
 * `stantal watch` — the half that speaks up on its own.
 *
 * Built for a scheduled workflow rather than a terminal, so the default output
 * is JSON and the human rendering is the opt-in. It decides what is worth
 * saying and writes the files that say it; branch, commit and pull request are
 * the workflow's job, where they can be read and audited by whoever runs them.
 */
async function runWatch(
  values: {
    json?: boolean | undefined;
    cache?: string | undefined;
    directory?: string | undefined;
    concurrency?: number | undefined;
    repo?: RepoSource | undefined;
    out?: string | undefined;
    write?: boolean | undefined;
    text?: boolean | undefined;
  },
  judge: Judge | null,
  behaviour: BehaviourOptions | undefined,
): Promise<number> {
  const directory = values.directory ?? process.cwd();

  const plan = await watchProject({
    directory,
    registry: pacoteRegistry(),
    judge,
    ...(values.repo === undefined ? {} : { repo: values.repo }),
    ...(values.cache !== undefined ? { cacheRoot: values.cache } : {}),
    ...(values.out !== undefined ? { testDir: values.out } : {}),
    ...(values.concurrency !== undefined ? { concurrency: values.concurrency } : {}),
    ...(values.write === true ? { write: true } : {}),
    // Layer 2 here and nowhere else in the automatic path. A scheduled run is
    // the one place k calls per request per side is proportionate: it happens
    // at most once per release, and the answer lands on a pull request
    // somebody is deciding from rather than in a terminal somebody is skimming.
    ...(behaviour === undefined ? {} : { behaviour }),
  });

  // JSON by default here, unlike everywhere else. The caller is a workflow, and
  // making it pass a flag to get the only output it can use would be a small
  // trap laid for every person who copies the template. `--text` is the way
  // back to something a person reads, rather than `--json` being the way in.
  if (values.text !== true) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    process.stdout.write(`\n  ${bold("stantal watch")}  ${dim(watchSummary(plan))}\n\n`);
    if (plan.action !== "nothing") {
      process.stdout.write(`  ${bold(plan.title)}\n  ${dim(plan.branch)}\n\n${plan.body}\n\n`);
    }
  }

  // Exit 0 whatever it found. This runs on a schedule, and a red cron job that
  // is red on purpose trains everyone to ignore it — the finding travels in the
  // pull request, which is a thing a person reads, not in a status badge.
  return 0;
}

// --- Entry point -------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        surface: { type: "string", multiple: true },
        json: { type: "boolean" },
        "emit-tests": { type: "boolean" },
        out: { type: "string" },
        apply: { type: "boolean" },
        agent: { type: "string" },
        run: { type: "boolean" },
        directory: { type: "string" },
        html: { type: "string" },
        publish: { type: "string" },
        "no-judge": { type: "boolean" },
        behaviour: { type: "boolean" },
        k: { type: "string" },
        replay: { type: "boolean" },
        cache: { type: "string" },
        name: { type: "string" },
        "fields-at": { type: "string" },
        "exclude-when": { type: "string", multiple: true },
        repo: { type: "string" },
        all: { type: "boolean" },
        "emit-patch": { type: "boolean" },
        write: { type: "boolean" },
        text: { type: "boolean" },
        current: { type: "string" },
        against: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        concurrency: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`stantal ${ownVersion()}\n`);
    return 0;
  }

  loadDotEnv();
  if (values.replay === true) applyReplay(process.env);
  const judge = values["no-judge"] === true ? null : judgeFromEnv();
  warnIfGeminiBillsACard(judge?.id);

  // Validated before anything branches on it, so it means the same thing on
  // the walk (version fetches) and on Layer 2 (calls in flight). Strict digits
  // for the same reason as `--k`: `parseInt` stops at the first non-digit, so
  // `--concurrency 1e3` would quietly become 1.
  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    if (!/^\d+$/.test(values.concurrency) || Number.parseInt(values.concurrency, 10) < 1) {
      process.stderr.write(
        `stantal: --concurrency must be a positive whole number, got "${values.concurrency}"\n`,
      );
      return 2;
    }
    concurrency = Number.parseInt(values.concurrency, 10);
  }

  if (positionals[0] === "history") {
    // Refused rather than quietly ignored. A walk runs the pair logic once per
    // release, so Layer 2 here is k calls per request per side times every
    // version in the range — the one place in this CLI where a single flag can
    // turn a cheap command into a very expensive one by accident.
    if (values.behaviour === true) {
      process.stderr.write(
        `stantal: --behaviour is not available on a history walk — its cost multiplies by
every release in the range. Run it on a single pair instead.
`,
      );
      return 2;
    }
    return runHistory(positionals[1], values, judge);
  }

  // Checked before the work starts, and before anything branches on it, so
  // `--k` means the same thing on every path. Validating it inside the caller
  // branch let the same bad value exit 2 with a key present and pass silently
  // without one — and validating it after the fetch would spend a download
  // before rejecting an argument that was wrong from the start.
  //
  // Strict digits rather than `parseInt`, which stops at the first non-digit:
  // `--k 1e3` would become 1, quietly handing back the weakest possible sample
  // to someone who asked for the strongest, and `--k 8x` would be accepted.
  let k: number | undefined;
  if (values.k !== undefined) {
    if (!/^\d+$/.test(values.k) || Number.parseInt(values.k, 10) < 1) {
      process.stderr.write(`stantal: --k must be a positive whole number, got "${values.k}"\n`);
      return 2;
    }
    k = Number.parseInt(values.k, 10);
    if (values.behaviour !== true) {
      process.stderr.write("stantal: --k only applies with --behaviour, and was ignored.\n");
    }
  }

  let behaviour: BehaviourOptions | undefined;
  if (values.behaviour === true) {
    const caller = callerFromEnv();
    warnIfGeminiBillsACard(caller?.id);
    if (caller === null) {
      // Warned, not fatal. The report is still worth producing, and the rule
      // everywhere else in this tool is that a missing key degrades an answer
      // rather than withholding one. But the user asked for this by name, so
      // silence would be the wrong kind of quiet.
      process.stderr.write(
        `stantal: --behaviour needs a model key (ANTHROPIC_API_KEY, OPENAI_API_KEY or
GEMINI_API_KEY). Continuing without Layer 2.
`,
      );
    } else {
      behaviour = {
        caller,
        cache: behaviourCacheFromEnv(),
        ...(k === undefined ? {} : { k }),
        ...(concurrency === undefined ? {} : { concurrency }),
      };
    }
  }

  // Built once, before anything branches, so Layer 3 means the same thing on
  // every command.
  //
  // **On by default, pointed at the working directory.** It was opt-in first,
  // on the reasoning that this is the only layer that reads private code. That
  // reasoning was wrong in one specific way: the caution belongs on sending
  // something out, not on reading something in. Nothing here leaves the
  // machine, the GitHub Action has defaulted it to "." since it shipped, and
  // the effect of the old default was that the CI path answered "does this
  // reach you" while the path a person actually types did not. `--repo none`
  // turns it off; `--repo <dir>` still points it somewhere else.
  const repoArg = values.repo ?? ".";
  const repo = repoArg === "none" ? undefined : fsRepoSource(repoArg);

  // No subcommand and no package: the question somebody standing in a
  // repository actually has. This is the default because remembering a package
  // name and two versions is a thing almost nobody can do before something has
  // already broken.
  if (positionals[0] === "watch") {
    return runWatch(
      {
        ...(values.json === undefined ? {} : { json: values.json }),
        ...(values.cache === undefined ? {} : { cache: values.cache }),
        ...(values.directory === undefined ? {} : { directory: values.directory }),
        ...(values.out === undefined ? {} : { out: values.out }),
        ...(values.write === undefined ? {} : { write: values.write }),
        ...(values.text === undefined ? {} : { text: values.text }),
        ...(repo === undefined ? {} : { repo }),
        ...(concurrency === undefined ? {} : { concurrency }),
      },
      judge,
      behaviour,
    );
  }

  if (positionals.length === 0 || positionals[0] === "audit") {
    return runAudit(
      {
        ...(values.json === undefined ? {} : { json: values.json }),
        ...(values.cache === undefined ? {} : { cache: values.cache }),
        ...(values.directory === undefined ? {} : { directory: values.directory }),
        ...(values.out === undefined ? {} : { out: values.out }),
        ...(repo === undefined ? {} : { repo }),
        ...(concurrency === undefined ? {} : { concurrency }),
      },
      judge,
    );
  }

  if (positionals[0] === "check") {
    return runCheck(positionals[1], values, judge, behaviour, repo);
  }

  if (positionals[0] === "manifest") {
    return runManifest(positionals[1], positionals[2], values, judge, behaviour, repo);
  }

  if (positionals[0] === "mcp") {
    await serveStdio({ judge, version: ownVersion() });
    return 0;
  }

  if (positionals[0] === "connect") {
    return runConnect(values);
  }

  if (positionals[0] === "patch") {
    return runPatch(positionals[1], positionals[2], values, judge);
  }

  if (positionals[0] === "pin") {
    return runPin(positionals[1], values);
  }

  const [pkg, from, to] = positionals;
  if (pkg === undefined || from === undefined || to === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const report = await buildReport({
      package: pkg,
      from,
      to,
      registry: pacoteRegistry(),
      judge,
      ...(behaviour === undefined ? {} : { behaviour }),
      ...(values.cache !== undefined ? { cacheRoot: values.cache } : {}),
      ...(values.surface !== undefined ? { subpaths: values.surface } : {}),
      ...(repo === undefined ? {} : { repo }),
    });

    process.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    if (values.html !== undefined) writeHtmlVerdict(report, values.html);
    const host = verdictHost(values);
    if (host !== null) await publishVerdict(report, host);
    if (values["emit-tests"] === true) emitFromReport(report, values.out);
    return exitCodeFor(report.verdict);
  } catch (error) {
    // Anything that stops us reading is exit 2, never a verdict. A tool that
    // reports "clean" because it crashed is worse than one that says nothing.
    process.stderr.write(`stantal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

// Run only when invoked directly, so tests can import `main` without it firing.
// Compared as file URLs because a bare path comparison does not survive Windows.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`stantal: ${String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
