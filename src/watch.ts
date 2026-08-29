import { join, relative, sep } from "node:path";
import { auditProject, heldByRange, isUnreachable, type AuditEntry, type AuditResult } from "./audit.js";
import { assertionsFromContract } from "./emit/assertions.js";
import { emitTests, type EmitTarget, type WrittenFile } from "./emit/write.js";
import { extractFromModule } from "./extract/module.js";
import { fsPackageSource } from "./extract/package-source.js";
import { packageDirectory } from "./testkit.js";
import { countFindings, type Report } from "./report.js";
import type { AuditOptions } from "./audit.js";

/**
 * The autonomous half: something that watches, and speaks up on its own.
 *
 * Every other entry point waits to be asked. Somebody has to remember that
 * contract drift exists on the day it happens to matter, and nobody does — that
 * is the whole reason the defect in the anchoring case survived 53 releases with
 * its own explanation sitting in a comment three lines above the dispatch.
 *
 * **It ships the proof, not the fix.** A failing test is checkable in one
 * command by somebody who has never heard of us. A speculative edit asks a
 * stranger to trust our judgement about their code, on a pull request they did
 * not open, from a tool they installed yesterday. The fix can come later, gated
 * on a measured precision number rather than on a date.
 *
 * The git and GitHub plumbing lives in the workflow, not here. This decides
 * what is worth saying and writes the files that say it; a workflow that can be
 * read in thirty seconds does the branch, the commit and the API call.
 */

/** What the watcher concluded, and why. */
export type WatchAction =
  /** Nothing waiting and nothing unprotected. Say nothing; a bot that speaks every day is muted by week two. */
  | "nothing"
  /**
   * Contracts here have no tests. Open a pull request that adds them.
   *
   * Safe to merge: the assertions describe what is installed today, so they
   * pass on the branch and on `main`. The value arrives later, on the upgrade.
   */
  | "guard"
  /**
   * An upgrade is waiting that changes what a model reads, and this project's
   * declared range admits it. Say so, with the reach, on the bump if one is
   * already open and on a pull request of our own if not.
   */
  | "warn";

export type WatchSubject = {
  package: string;
  installed: string;
  latest: string | null;
  /** Present when there is a verdict to report. */
  verdict: string | null;
  headline: string | null;
  /** Places in this repository the findings touch. */
  reaches: Array<{ kind: string; target: string; evidence: string }>;
  /** True when the declared range cannot admit the affected version yet. */
  heldByRange: boolean;
  /** Entry points with no contract tests. */
  unpinnedSubpaths: string[];
};

export type WatchPlan = {
  action: WatchAction;
  /** Branch name for a pull request of our own. Stable across runs on the same finding. */
  branch: string;
  title: string;
  /** Markdown for a pull request body. */
  body: string;
  /**
   * A shorter markdown note for commenting on somebody else's bump.
   *
   * Empty when there is nothing to warn about. A comment on a Renovate pull
   * request has to earn its place in a thread the author is already reading, so
   * it says the finding and stops.
   */
  comment: string;
  /** Packages worth searching existing pull requests for. */
  packages: string[];
  /** Test files to write, and whether they were actually written. */
  tests: WrittenFile[];
  /** Dependencies the run could not read, which narrows what any of this claims. */
  unreadable: string[];
  generatedAt: string;
};

export type WatchOptions = AuditOptions & {
  /** Where contract tests go. */
  testDir?: string;
  /** Write the test files. Off by default: deciding and doing are separate. */
  write?: boolean;
};

/**
 * A dependency worth opening a pull request about.
 *
 * Deliberately narrower than "has a finding". A finding on a version this
 * project's own range cannot install is real and is not news — nothing here
 * changes until somebody widens that line, and a bot that files a pull request
 * about it every night is a bot that gets turned off.
 */
function worthWarning(entry: AuditEntry): boolean {
  if (entry.report === null) return false;
  if (entry.report.verdict === "clean") return false;
  // `heldByRange` is false both when the range admits the defect and when
  // nobody scanned for a range at all. Those are opposite states, and this
  // resolves them in the noisy direction on purpose: without a Layer 3 read we
  // do not know that the consumer is safe, and staying quiet on a thing we did
  // not check is the one failure mode a watcher must not have.
  return !heldByRange(entry);
}

function unpinnedOf(entry: AuditEntry): string[] {
  return entry.subpaths.filter((s) => !entry.pinnedSubpaths.includes(s));
}

function subjectOf(entry: AuditEntry): WatchSubject {
  return {
    package: entry.package,
    installed: entry.installed,
    latest: entry.latest,
    verdict: entry.report?.verdict ?? null,
    headline: entry.report?.headline ?? null,
    reaches:
      entry.report?.blast?.reaches.slice(0, 10).map((r) => ({
        kind: r.kind,
        target: r.target,
        evidence: r.evidence,
      })) ?? [],
    heldByRange: heldByRange(entry),
    unpinnedSubpaths: unpinnedOf(entry),
  };
}

/**
 * A branch name that is the same on every run about the same thing.
 *
 * Derived from the packages and the versions being warned about, never from the
 * date or a counter. A branch keyed on the day files a fresh pull request every
 * night for one unchanged finding, and the second one is already noise.
 */
export function branchFor(action: WatchAction, subjects: readonly WatchSubject[]): string {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  if (action === "guard") return "stantal/pin-contracts";
  const parts = subjects
    .filter((s) => s.verdict !== null)
    .map((s) => `${slug(s.package)}-${slug(s.latest ?? "unknown")}`)
    .sort();
  return `stantal/contract-${parts.join("_").slice(0, 80)}`;
}

export async function watchProject(options: WatchOptions): Promise<WatchPlan> {
  const result = await auditProject(options);
  const testDir = options.testDir ?? "stantal";

  const warn = result.entries.filter(worthWarning);
  const unpinned = result.entries.filter((e) => unpinnedOf(e).length > 0);
  const unreadable = result.entries.filter(isUnreachable).map((e) => e.package);

  const action: WatchAction = warn.length > 0 ? "warn" : unpinned.length > 0 ? "guard" : "nothing";
  const subjects = (warn.length > 0 ? warn : unpinned).map(subjectOf);

  // Written for every unpinned contract, not only the ones being warned about.
  // The pull request is open either way, and a contract with no tests is the
  // condition that let the next finding through unnoticed.
  const tests =
    action === "nothing" ? [] : writeGuards(result, unpinned, testDir, options.write === true, options.directory);

  return {
    action,
    branch: branchFor(action, subjects),
    title: titleFor(action, subjects),
    body: bodyFor(action, subjects, tests, unreadable, result),
    comment: warn.length > 0 ? commentFor(subjects.filter((s) => s.verdict !== null)) : "",
    packages: subjects.map((s) => s.package),
    tests,
    unreadable,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Contract tests pinned to what is installed, never to the newer side.
 *
 * That direction is the whole point. Assertions taken from the release being
 * warned about describe the defect and pass on it; assertions taken from the
 * version in use fail the moment the upgrade lands, which is the proof somebody
 * can check without believing a word of the pull request body.
 */
function writeGuards(
  result: AuditResult,
  unpinned: readonly AuditEntry[],
  testDir: string,
  write: boolean,
  directory: string,
): WrittenFile[] {
  const targets: EmitTarget[] = [];

  for (const entry of unpinned) {
    const dir = packageDirectory(entry.package, directory);
    if (dir === null) continue;
    const source = fsPackageSource(dir);

    for (const subpath of unpinnedOf(entry)) {
      const read = extractFromModule({
        package: entry.package,
        version: entry.installed,
        subpath,
        source,
      });
      if (!read.present) continue;
      targets.push({
        package: entry.package,
        subpath,
        version: entry.installed,
        assertions: assertionsFromContract(read.contract, subpath, read.notes),
      });
    }
  }

  const written = emitTests({
    directory: join(directory, testDir),
    targets,
    generator: "stantal",
    // Deciding and doing are separate calls. A watcher that writes on the way
    // to working out whether it had anything to say would leave files behind
    // on every quiet night.
    dryRun: !write,
  });

  // Reported repo-relative, always with forward slashes. These paths go into a
  // pull request body that other people read: an absolute path is meaningless
  // to them, it publishes the layout of whatever machine the runner happened to
  // be, and on Windows it arrives full of backslashes that markdown eats.
  return written.map((file) => ({
    ...file,
    path: relative(directory, file.path).split(sep).join("/"),
  }));
}

function titleFor(action: WatchAction, subjects: readonly WatchSubject[]): string {
  if (action === "nothing") return "";
  if (action === "guard") {
    const n = subjects.length;
    return `Pin the tool contracts of ${n} dependency${n === 1 ? "" : "/ies"}`;
  }
  const first = subjects[0];
  const others = subjects.length - 1;
  const tail = others > 0 ? ` (and ${others} more)` : "";
  return `${first?.package} ${first?.installed} → ${first?.latest} changes what a model reads${tail}`;
}

function bodyFor(
  action: WatchAction,
  subjects: readonly WatchSubject[],
  tests: readonly WrittenFile[],
  unreadable: readonly string[],
  result: AuditResult,
): string {
  if (action === "nothing") return "";

  const out: string[] = [];

  if (action === "warn") {
    out.push(
      "An upgrade is waiting that changes the tool contract a language model reads.",
      "Semver, type-checking and your test suite all pass through it unchanged.",
      "",
    );
    for (const s of subjects.filter((x) => x.verdict !== null)) {
      out.push(`### \`${s.package}\` ${s.installed} → ${s.latest}`, "", `**${s.verdict}** — ${s.headline}`, "");
      if (s.reaches.length > 0) {
        out.push(`Reaches this repository in ${s.reaches.length} place(s):`, "");
        for (const r of s.reaches) out.push(`- \`${r.evidence}\` — ${r.kind} \`${r.target}\``);
        out.push("");
      } else {
        out.push("_Nothing in this repository was found to reference it._", "");
      }
      out.push(
        `<details><summary>Check it yourself</summary>`,
        "",
        "```bash",
        `npx stantal ${s.package} ${s.installed} ${s.latest}`,
        "```",
        "",
        "</details>",
        "",
      );
    }
  } else {
    out.push(
      `${subjects.length} of this project's dependencies hand a language model a tool contract, and none of them are covered by a test.`,
      "",
      "A contract can lose a tool, a parameter, or the sentence explaining when to pass one, without a single type error.",
      "",
    );
  }

  if (tests.length > 0) {
    out.push(
      "## What this pull request adds",
      "",
      `${tests.length} contract test file(s), recording what each package offers **today**:`,
      "",
    );
    for (const t of tests) out.push(`- \`${t.path}\` — ${t.assertions} assertion(s) on \`${t.subpath}\``);
    out.push(
      "",
      "They pass on this branch and on `main`. They fail the day an upgrade takes any of it away.",
      "",
      "**This pull request contains no upgrade and no change to your source.** Only test files.",
      "",
    );
  }

  if (unreadable.length > 0) {
    // Never dropped. A dependency we failed to read is not a dependency we
    // cleared, and a reader who cannot see the difference is being misled by
    // omission.
    out.push(
      "## Not checked",
      "",
      `These could not be read, so nothing above claims anything about them: ${unreadable
        .map((p) => `\`${p}\``)
        .join(", ")}.`,
      "",
    );
  }

  if (!result.readiness.hasRunner) {
    out.push(
      "> **Nothing in this project runs tests.** These files will never execute until there is a runner, and a suite that cannot fail is the one thing this was meant to avoid. `npm install -D vitest` and a `test` script fixes it.",
      "",
    );
  }

  out.push("---", "", `Opened by [stantal](https://github.com/hellunleash/stantal). Nothing was sent anywhere.`);
  return out.join("\n");
}

function commentFor(subjects: readonly WatchSubject[]): string {
  const out: string[] = ["**stantal:** this bump changes the tool contract a language model reads.", ""];
  for (const s of subjects) {
    out.push(`**\`${s.package}\` ${s.installed} → ${s.latest}** — ${s.verdict}`, "", s.headline ?? "", "");
    if (s.reaches.length > 0) {
      out.push(`Touches ${s.reaches.length} place(s) here, including \`${s.reaches[0]?.evidence}\`.`, "");
    }
  }
  out.push("```bash", `npx stantal ${subjects[0]?.package} ${subjects[0]?.installed} ${subjects[0]?.latest}`, "```");
  return out.join("\n");
}

/** The one-line summary a workflow log should carry. */
export function watchSummary(plan: WatchPlan): string {
  if (plan.action === "nothing") return "nothing waiting, nothing unprotected";
  if (plan.action === "guard") return `${plan.tests.length} contract(s) unprotected — opening a pull request`;
  return `${plan.packages.length} upgrade(s) change what a model reads`;
}

/** Findings per layer across every warned subject, for the workflow's outputs. */
export function watchCounts(reports: readonly (Report | null)[]): {
  structural: number;
  prose: number;
  behavioural: number;
} {
  const totals = { structural: 0, prose: 0, behavioural: 0 };
  for (const report of reports) {
    if (report === null) continue;
    const counts = countFindings(report);
    totals.structural += counts.structural;
    totals.prose += counts.prose;
    totals.behavioural += counts.behavioural;
  }
  return totals;
}
