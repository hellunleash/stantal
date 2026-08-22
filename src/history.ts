import { isPresent, type SurfaceResult } from "./contract/surface.js";
import { diffSurfaces } from "./diff/surface.js";
import { extractFromModule } from "./extract/module.js";
import { exportedSubpaths } from "./extract/package-source.js";
import { classifyProse } from "./prose/classify.js";
import type { Judge } from "./prose/judge.js";
import type { ProseFinding, ProseRule, Severity } from "./prose/taxonomy.js";
import { installPackage } from "./registry/install.js";
import type { Registry } from "./registry/npm.js";

/**
 * Walking a package's whole release history.
 *
 * Two things come out of one pass, and they are the two things nobody else can
 * produce:
 *
 * 1. **The onset.** Not "this version is broken" but *"this is the release that
 *    broke it, and this is the last one that was fine."* A consumer stranded
 *    eleven releases back does not need a diff against latest; they need the hop.
 * 2. **The count.** How many contract changes across a whole history a model
 *    would read differently — and how many of them any type checker would have
 *    caught. That second number is the argument.
 *
 * Affordable because a published version is immutable. Each version is fetched
 * and read exactly once, then held in memory for the two comparisons it takes
 * part in. Re-running the walk tomorrow costs nothing but the model calls.
 */

export type HistoryOptions = {
  package: string;
  registry: Registry;
  /** Null runs with no judge: findings stand, marked unconfirmed. */
  judge?: Judge | null;
  cacheRoot?: string;
  /** Restrict the walk, inclusive. Left unset, the whole published history. */
  since?: string;
  until?: string;
  subpaths?: readonly string[];
  /** Parallel version fetches. Kept low so a backfill is not a registry incident. */
  concurrency?: number;
  dependencyDepth?: number;
  onProgress?: (done: number, total: number, version: string) => void;
};

/**
 * Identity of a finding across versions.
 *
 * Deliberately excludes the version, so the same defect in twenty consecutive
 * releases is one row with a start and an end, not twenty rows.
 */
export type FindingKey = string;

export function findingKey(subpath: string, finding: ProseFinding): FindingKey {
  return `${subpath}|${finding.rule}|${finding.target}`;
}

export type Onset = {
  key: FindingKey;
  subpath: string;
  rule: ProseRule;
  target: string;
  severity: Severity;
  headline: string;
  /** The release it appeared in. */
  introducedAt: string;
  /** The release before it — the last one a consumer could sit on safely. */
  lastCleanVersion: string | null;
  /** First release where it is gone again, or null if it never went. */
  resolvedAt: string | null;
  /** How many published releases carried it. */
  releasesAffected: number;
};

export type HistoryStep = {
  version: string;
  /** The release before this one, or null for the first walked. */
  previous: string | null;
  /** Prose findings present at this version. */
  findings: number;
  /** Structural changes that break a caller written against the previous release. */
  structuralBreaks: number;
  /** Surfaces that could not be read well enough to compare. */
  unreadableSurfaces: string[];
};

export type HistoryResult = {
  package: string;
  versions: string[];
  steps: HistoryStep[];
  onsets: Onset[];
  judge: string;
  /**
   * The headline number: findings a model would read differently, against those
   * a type checker would also have caught.
   */
  summary: {
    versionsWalked: number;
    distinctFindings: number;
    /** Findings still present at the last version walked. */
    unresolved: number;
    /** Of the distinct findings, how many coincided with a structural break. */
    alsoStructural: number;
    /** Findings with no structural signal at all — invisible to every other tool. */
    silent: number;
  };
};

/** Bounded parallelism. A backfill should not look like an attack. */
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

/** Every surface of one version, read once. */
type VersionRead = {
  version: string;
  surfaces: Map<string, SurfaceResult>;
  missing: string[];
};

async function readVersion(version: string, options: HistoryOptions): Promise<VersionRead> {
  const installed = await installPackage(options.package, version, {
    registry: options.registry,
    ...(options.cacheRoot ? { root: options.cacheRoot } : {}),
    ...(options.dependencyDepth !== undefined ? { depth: options.dependencyDepth } : {}),
  });

  const subpaths = options.subpaths ?? exportedSubpaths(installed.source.packageJson() ?? {});
  const surfaces = new Map<string, SurfaceResult>();
  for (const subpath of subpaths) {
    surfaces.set(
      subpath,
      extractFromModule({
        package: options.package,
        version,
        subpath,
        source: installed.source,
      }),
    );
  }

  return { version, surfaces, missing: installed.missing };
}

export async function walkHistory(options: HistoryOptions): Promise<HistoryResult> {
  const published = await options.registry.versions(options.package);
  const all = published.map((v) => v.version);

  const startAt = options.since === undefined ? 0 : all.indexOf(options.since);
  const endAt = options.until === undefined ? all.length - 1 : all.indexOf(options.until);
  if (startAt === -1) throw new Error(`${options.package} has no published version ${options.since}`);
  if (endAt === -1) throw new Error(`${options.package} has no published version ${options.until}`);

  const versions = all.slice(startAt, endAt + 1);
  const judge = options.judge ?? undefined;

  let done = 0;
  const reads = await pooled(versions, options.concurrency ?? 4, async (version) => {
    const read = await readVersion(version, options);
    options.onProgress?.(++done, versions.length, version);
    return read;
  });

  const steps: HistoryStep[] = [];
  // Key -> the versions it was present at, in order. Sparse gaps are real: a
  // finding can be introduced, fixed, and reintroduced.
  const presence = new Map<FindingKey, { finding: ProseFinding; subpath: string; versions: string[] }>();

  for (const [index, read] of reads.entries()) {
    const previous = index === 0 ? null : reads[index - 1];
    let findings = 0;
    let structuralBreaks = 0;
    const unreadableSurfaces: string[] = [];

    for (const [subpath, current] of read.surfaces) {
      const before = previous?.surfaces.get(subpath);

      if (before !== undefined) {
        const comparison = diffSurfaces(before, current);
        if (comparison.breaking) structuralBreaks += comparison.diff?.changes.filter((c) => c.breaking).length ?? 1;
        if (comparison.kind === "not_comparable") unreadableSurfaces.push(subpath);
      }

      if (!isPresent(current)) continue;

      // The first version walked has no predecessor, so it is classified alone.
      // Without that, a defect present from the very first release would be
      // reported as introduced by the second one.
      const prose = await classifyProse(
        before !== undefined && isPresent(before) ? before : null,
        current,
        judge,
      );
      findings += prose.findings.length;

      for (const finding of prose.findings) {
        const key = findingKey(subpath, finding);
        const entry = presence.get(key);
        if (entry === undefined) presence.set(key, { finding, subpath, versions: [read.version] });
        else entry.versions.push(read.version);
      }
    }

    steps.push({
      version: read.version,
      previous: previous?.version ?? null,
      findings,
      structuralBreaks,
      unreadableSurfaces,
    });
  }

  const byVersion = new Map(versions.map((v, i) => [v, i]));
  const lastWalked = versions[versions.length - 1];

  const onsets: Onset[] = [...presence.entries()]
    .map(([key, entry]) => {
      const first = entry.versions[0] ?? "";
      const firstIndex = byVersion.get(first) ?? 0;
      const last = entry.versions[entry.versions.length - 1];
      const stillPresent = last === lastWalked;
      const lastIndex = byVersion.get(last ?? first) ?? firstIndex;

      return {
        key,
        subpath: entry.subpath,
        rule: entry.finding.rule,
        target: entry.finding.target,
        severity: entry.finding.severity,
        headline: entry.finding.headline,
        introducedAt: first,
        // The release immediately before onset is the last one a consumer could
        // sit on without this defect. That is the number they actually want.
        lastCleanVersion: firstIndex > 0 ? (versions[firstIndex - 1] ?? null) : null,
        resolvedAt: stillPresent ? null : (versions[lastIndex + 1] ?? null),
        releasesAffected: entry.versions.length,
      };
    })
    .sort((a, b) => (byVersion.get(a.introducedAt) ?? 0) - (byVersion.get(b.introducedAt) ?? 0));

  // A finding "also structural" means some other tool had a chance. The rest are
  // the silent ones, and that count is the argument.
  const breakingVersions = new Set(steps.filter((s) => s.structuralBreaks > 0).map((s) => s.version));
  const alsoStructural = onsets.filter((o) => breakingVersions.has(o.introducedAt)).length;

  return {
    package: options.package,
    versions,
    steps,
    onsets,
    judge: judge?.id ?? "none",
    summary: {
      versionsWalked: versions.length,
      distinctFindings: onsets.length,
      unresolved: onsets.filter((o) => o.resolvedAt === null).length,
      alsoStructural,
      silent: onsets.length - alsoStructural,
    },
  };
}
