#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isPresent } from "./contract/surface.js";
import { judgeFromEnv } from "./prose/judges.js";
import { pacoteRegistry } from "./registry/npm.js";
import { walkHistory, type HistoryResult } from "./history.js";
import { buildReport, exitCodeFor, type Report, type SurfaceReport } from "./report.js";

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

  stantal <package> <from> <to> [options]
  stantal history <package> [options]

Comparing two versions tells you whether to take an upgrade.
Walking the history tells you which release broke it, and the last one that
was fine — which is what a stranded consumer actually needs.

Options
  --surface <subpath>   Read one door only, e.g. "." or "./ai-sdk".
                        Repeatable. Default: every subpath the package exports.
  --json                Print the full report as JSON.
  --no-judge            Skip the model judge even if a key is set.
  --cache <dir>         Where unpacked versions live. Default .stantal/npm
  --since <version>     history: start here instead of the first release.
  --until <version>     history: stop here instead of the latest.
  --concurrency <n>     history: parallel version fetches. Default 4.
  --help, --version

Exit codes
  0  clean          nothing a model would read differently
  1  found          a change worth looking at
  2  unreadable     could not read enough to say

The judge is optional and off unless a key is present. It reads
ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY / GOOGLE_API_KEY.
STANTAL_JUDGE forces a provider or "none"; STANTAL_JUDGE_MODEL picks a model.
`.trim();

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

function renderSurface(surface: SurfaceReport): string[] {
  const lines: string[] = [];
  const changes = surface.comparison.diff?.changes ?? [];
  const findings = surface.prose.findings;

  const quiet =
    changes.length === 0 &&
    findings.length === 0 &&
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

  // Withheld claims are printed, never dropped. A silent omission would read as
  // a clean bill on something we simply could not see.
  for (const withheld of surface.comparison.suppressed) {
    lines.push(`    ${dim(`withheld  ${withheld.rule}  ${withheld.target} — extraction could not read the whole contract`)}`);
  }
  for (const skipped of surface.prose.skipped) {
    lines.push(`    ${dim(`withheld  ${skipped.target} — ${skipped.reason}`)}`);
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
  out.push(`  ${dim(judgeNote)}`, `  ${dim("run with --json for the full report")}`, "");

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

async function runHistory(
  pkg: string | undefined,
  values: { json?: boolean | undefined; cache?: string | undefined; since?: string | undefined; until?: string | undefined; concurrency?: string | undefined; surface?: string[] | undefined },
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

    process.stdout.write(quiet ? `${JSON.stringify(result, null, 2)}\n` : renderHistory(result));
    return result.summary.distinctFindings > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`stantal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
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
        "no-judge": { type: "boolean" },
        cache: { type: "string" },
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
    process.stdout.write("stantal 0.0.0\n");
    return 0;
  }

  loadDotEnv();
  const judge = values["no-judge"] === true ? null : judgeFromEnv();

  if (positionals[0] === "history") {
    return runHistory(positionals[1], values, judge);
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
      ...(values.cache !== undefined ? { cacheRoot: values.cache } : {}),
      ...(values.surface !== undefined ? { subpaths: values.surface } : {}),
    });

    process.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : render(report));
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
