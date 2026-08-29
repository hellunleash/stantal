import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exportedSubpaths, fsPackageSource } from "./extract/package-source.js";
import { extractFromModule } from "./extract/module.js";
import { packageDirectory } from "./testkit.js";
import { testFileName } from "./emit/vitest.js";
import { hostReadiness, type HostReadiness } from "./emit/host.js";
import { buildReport, type BehaviourOptions, type Report, type VerdictLevel } from "./report.js";
import type { Registry } from "./registry/npm.js";
import type { Judge } from "./prose/judge.js";
import type { RepoSource } from "./blast/repo.js";

/**
 * The whole product with no arguments.
 *
 *     npx stantal
 *
 * Every other command in this CLI asks the user to already know something: a
 * package name, two versions, which door to read. Almost nobody knows those
 * before they have a problem, and by then it is not a warning, it is an
 * incident. This command asks for nothing and answers the question anyone
 * standing in a repository actually has — is any of this about to move under
 * me, and what should I do about it.
 *
 * **It reads and it ranks. It never writes.** Writing contract tests is a real
 * change to somebody's repository, and a no-argument command that edits files
 * on first run is how a tool gets uninstalled. The plan ends by naming the
 * command that writes, and that command runs because it was asked for.
 */

/** One contract-bearing dependency, and what it is about to do to you. */
export type AuditEntry = {
  package: string;
  /** The version resolved in node_modules right now. */
  installed: string;
  /** What a fresh install would give you today, or null when the registry could not say. */
  latest: string | null;
  /** The subpaths that actually ship tools. Not every door of the package. */
  subpaths: string[];
  tools: number;
  /** Subpaths that already have contract tests on disk. */
  pinnedSubpaths: string[];
  /**
   * The verdict on installed -> latest, or null when there was none to reach.
   *
   * Null is never a pass. `note` says which kind of null it is, because "you
   * are already on the newest release" and "we could not fetch it" are
   * opposite claims and only one of them lets you stop reading.
   */
  report: Report | null;
  note: string | null;
};

export type AuditResult = {
  directory: string;
  /** Every dependency declared in the manifest, contract-bearing or not. */
  declared: number;
  /** Contract-bearing dependencies, worst first. */
  entries: AuditEntry[];
  /** Whether anything here could run the tests `pin` would write. */
  readiness: HostReadiness;
  generatedAt: string;
};

export type AuditOptions = {
  directory: string;
  registry: Registry;
  judge?: Judge | null;
  /** Layer 3. The audit runs inside a repository by definition, so this is normally set. */
  repo?: RepoSource;
  cacheRoot?: string;
  /** Where contract tests live, for the already-pinned check. */
  testDir?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number, pkg: string) => void;
  /**
   * Layer 2, per pair. Left unset it does not run and no model is ever called.
   *
   * Deliberately not offered on the local no-argument command. There it would
   * turn a command somebody types casually into k calls per request per side
   * per dependency, which is exactly the surprise bill that gets a tool
   * uninstalled. `stantal watch` is where it earns its cost: it runs on a
   * schedule, at most once per release, and the answer lands on a pull request
   * somebody is deciding from.
   */
  behaviour?: BehaviourOptions;
};

/**
 * Which installed dependencies ship a contract a model reads.
 *
 * Offline and quick, because it is the first question and a slow first question
 * does not get asked twice.
 *
 * Lives here rather than beside the MCP server so the default CLI path does not
 * pull the MCP SDK in behind it. The server is a front end for this function,
 * not its owner.
 */
export function contractDependencies(directory: string): Array<{
  package: string;
  version: string;
  subpaths: string[];
  tools: number;
}> {
  const manifest = readManifest(directory);
  if (manifest === null) return [];

  const out: Array<{ package: string; version: string; subpaths: string[]; tools: number }> = [];
  for (const name of declaredDependencies(manifest)) {
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

function readManifest(directory: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every dependency named in the manifest, deduplicated and sorted. */
export function declaredDependencies(manifest: Record<string, unknown>): string[] {
  const named = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = manifest[field];
    if (block !== null && typeof block === "object") {
      for (const name of Object.keys(block as Record<string, unknown>)) named.add(name);
    }
  }
  return [...named].sort();
}

/**
 * Rank, worst first — the same order `report.ts` folds surfaces in, for the
 * same reason. `unreadable` outranks `clean` because a run that read nothing
 * must never present as a run that found nothing.
 *
 * An entry with no report at all sorts last, whatever the reason. It is either
 * already current or it could not be reached, and neither is an action.
 */
const RANK: Record<VerdictLevel, number> = {
  "behaviour-breaking": 0,
  "structurally-breaking": 1,
  "prose-risk": 2,
  unreadable: 3,
  clean: 4,
};

function rankOf(entry: AuditEntry): number {
  return entry.report === null ? 5 : RANK[entry.report.verdict];
}

/** How many places in this repository an entry's findings touch. */
export function reachCount(entry: AuditEntry): number {
  return entry.report?.blast?.reaches.length ?? 0;
}

/** True when the installed version is already the newest published one. */
export function isCurrent(entry: AuditEntry): boolean {
  return entry.latest !== null && entry.latest === entry.installed;
}

/**
 * A dependency the audit failed to reach, as distinct from one it read and
 * cleared. Only the second lets a caller stop reading.
 */
export function isUnreachable(entry: AuditEntry): boolean {
  return entry.report === null && !isCurrent(entry);
}

/**
 * The findings are real, and the range this project declares already excludes
 * every version carrying them.
 *
 * Worth its own answer because the advice is the opposite of the general case.
 * Telling somebody to hold a package their own manifest already holds is noise,
 * and noise in a list of four things to do is how the list stops being read.
 * What they need to know is narrower: this one is handled until you widen the
 * range, so do not widen it yet.
 *
 * Read off the `kind`, never the sentence. The wording is for people.
 */
export function heldByRange(entry: AuditEntry): boolean {
  const blast = entry.report?.blast;
  if (blast === undefined || blast === null) return false;
  if (blast.reaches.length > 0 || blast.notes.length > 0) return false;
  return blast.filtered.length > 0 && blast.filtered.every((f) => f.kind === "range_excludes");
}

async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * installed -> latest, not installed -> whatever your range allows.
 *
 * The range question belongs to Layer 3, and it is asked about a finding that
 * already exists. This one is about the upgrade sitting in front of you right
 * now: the one an agent is about to take, or a bot is about to open a PR for.
 * Resolving the `latest` dist-tag is exactly what `npm install <pkg>` does, so
 * the pair compared is the pair a person would actually end up with.
 */
export async function auditProject(options: AuditOptions): Promise<AuditResult> {
  const { directory, registry } = options;
  const testDir = options.testDir ?? "stantal";
  const manifest = readManifest(directory);
  const deps = contractDependencies(directory);
  let done = 0;

  const entries = await pooled(deps, options.concurrency ?? 4, async (dep) => {
    const pinnedSubpaths = dep.subpaths.filter((subpath) =>
      existsSync(join(directory, testDir, testFileName(dep.package, subpath))),
    );

    const base: AuditEntry = {
      package: dep.package,
      installed: dep.version,
      latest: null,
      subpaths: dep.subpaths,
      tools: dep.tools,
      pinnedSubpaths,
      report: null,
      note: null,
    };

    const finish = (entry: AuditEntry): AuditEntry => {
      options.onProgress?.(++done, deps.length, dep.package);
      return entry;
    };

    let latest: string;
    try {
      latest = (await registry.manifest(dep.package, "latest")).version;
    } catch (error) {
      // A registry we could not reach is a gap in our reading, never a clean
      // result. Said out loud, with the reason, so nobody reads silence here
      // as "this one is fine".
      return finish({ ...base, note: `could not reach the registry — ${message(error)}` });
    }

    if (latest === dep.version) {
      return finish({ ...base, latest, note: "already on the newest release" });
    }

    try {
      const report = await buildReport({
        package: dep.package,
        from: dep.version,
        to: latest,
        registry,
        subpaths: dep.subpaths,
        ...(options.judge === undefined ? {} : { judge: options.judge }),
        ...(options.behaviour === undefined ? {} : { behaviour: options.behaviour }),
        ...(options.repo === undefined ? {} : { repo: options.repo }),
        ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      });
      return finish({ ...base, latest, report });
    } catch (error) {
      return finish({ ...base, latest, note: `could not compare — ${message(error)}` });
    }
  });

  entries.sort((a, b) => {
    const byRank = rankOf(a) - rankOf(b);
    if (byRank !== 0) return byRank;
    // Within a verdict, the one that touches more of this repository first.
    const byReach = reachCount(b) - reachCount(a);
    if (byReach !== 0) return byReach;
    // Then the ones the consumer's own range already excludes, last. The
    // finding is real, but there is nothing here to do about it today.
    const byHeld = Number(heldByRange(a)) - Number(heldByRange(b));
    if (byHeld !== 0) return byHeld;
    return a.package.localeCompare(b.package);
  });

  return {
    directory,
    declared: manifest === null ? 0 : declaredDependencies(manifest).length,
    entries,
    readiness: hostReadiness(directory),
    generatedAt: new Date().toISOString(),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one line at the top, and what the exit code is derived from.
 *
 * Folded the way a single report folds its surfaces: worst wins, and
 * `unreadable` is not a pass. A dependency the audit could not reach leaves it
 * unable to say clean, exactly as an unreadable surface does inside one report
 * — because a CI step that goes green after failing to look is the precise
 * false claim this tool exists to avoid.
 */
export function auditVerdict(result: AuditResult): VerdictLevel | "nothing-to-check" {
  const verdicts = result.entries
    .map((e) => e.report?.verdict)
    .filter((v): v is VerdictLevel => v !== undefined);
  const unreachable = result.entries.some(isUnreachable);

  if (verdicts.length === 0) {
    if (unreachable) return "unreadable";
    return result.entries.length === 0 ? "nothing-to-check" : "clean";
  }

  const worst = verdicts.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
  return unreachable && RANK[worst] > RANK.unreadable ? "unreadable" : worst;
}
