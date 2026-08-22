import { isPresent, type SurfaceResult } from "./contract/surface.js";
import type { Surface } from "./contract/types.js";
import { diffSurfaces, type SurfaceComparison } from "./diff/surface.js";
import { extractFromModule } from "./extract/module.js";
import { exportedSubpaths } from "./extract/package-source.js";
import { classifyProse, type ProseResult } from "./prose/classify.js";
import type { Judge } from "./prose/judge.js";
import { installPackage } from "./registry/install.js";
import type { Registry } from "./registry/npm.js";

/**
 * The verdict artifact.
 *
 * One document per version pair: what changed on every door the package opens,
 * what that means, and the evidence for each claim. It is the unit of value, so
 * two rules hold everywhere in here.
 *
 * **Every claim carries its evidence.** A source line, a quoted sentence, a
 * confidence grade. What makes the document forwardable is that the person
 * receiving it can check it without trusting the sender.
 *
 * **The verdict is a small closed enum.** It is the field a CI job branches on,
 * so it is never prose.
 */

export type VerdictLevel =
  /** Nothing found, and extraction was good enough for that to mean something. */
  | "clean"
  /** Prose a model relies on changed, or a parameter ships with no guidance. */
  | "prose-risk"
  /** The shape changed in a way that breaks a caller written against the old contract. */
  | "structurally-breaking"
  /**
   * A model demonstrably behaves differently. Requires Layer 2, which is not
   * built — so nothing in this file may return it yet. It is in the enum because
   * a CI job branching on the field should not have to change when it arrives.
   */
  | "behaviour-breaking"
  /**
   * Extraction could not read enough to say anything. Not in the original spec's
   * enum, and added deliberately: reporting `clean` because we failed to read a
   * package would be the exact false claim this tool exists to avoid.
   */
  | "unreadable";

export type SurfaceReport = {
  /** The subpath a consumer imports, e.g. "." or "./ai-sdk". */
  subpath: string;
  from: SurfaceResult;
  to: SurfaceResult;
  comparison: SurfaceComparison;
  prose: ProseResult;
};

export type Report = {
  subject: {
    ecosystem: "npm";
    package: string;
    from: string;
    to: string;
  };
  verdict: VerdictLevel;
  /** One line a human reads first. Derived, never written by a model. */
  headline: string;
  surfaces: SurfaceReport[];
  /** Dependencies that could not be fetched, which narrows what could be read. */
  missingDependencies: string[];
  /** Which judge answered, or "none". */
  judge: string;
  generatedAt: string;
};

export type ReportOptions = {
  package: string;
  from: string;
  to: string;
  registry: Registry;
  /** Null runs Layer 1 with no judge: findings stand, marked unconfirmed. */
  judge?: Judge | null;
  cacheRoot?: string;
  /** Restrict to specific doors. Left unset, every declared subpath is read. */
  subpaths?: readonly string[];
  surface?: Surface;
  dependencyDepth?: number;
};

/**
 * Rank, worst first. Used to fold many surfaces into one answer.
 *
 * `unreadable` deliberately outranks `clean`: a run that read nothing must never
 * present as a run that found nothing.
 */
const RANK: Record<VerdictLevel, number> = {
  "behaviour-breaking": 0,
  "structurally-breaking": 1,
  "prose-risk": 2,
  unreadable: 3,
  clean: 4,
};

function verdictForSurface(report: SurfaceReport): VerdictLevel {
  if (report.comparison.breaking) return "structurally-breaking";
  if (report.prose.findings.length > 0) return "prose-risk";

  // Nothing found. Whether that means "clean" depends entirely on whether we
  // could see. A not-comparable pair, or a side we failed to parse, is silence
  // rather than evidence.
  if (report.comparison.kind === "not_comparable") return "unreadable";
  if (report.comparison.kind === "surface_absent") return "clean";
  if (report.prose.skipped.length > 0) return "unreadable";
  return "clean";
}

function headlineFor(report: Report): string {
  const surfaces = report.surfaces;
  const findings = surfaces.flatMap((s) => s.prose.findings);
  const structural = surfaces.flatMap((s) => s.comparison.diff?.changes ?? []).filter((c) => c.breaking);

  if (structural.length > 0) {
    const first = structural[0];
    return `${structural.length} breaking structural change(s), including \`${first?.target}\`.`;
  }

  if (findings.length > 0) {
    const worst = findings[0];
    const others = findings.length - 1;
    const tail = others > 0 ? ` (and ${others} more)` : "";
    return `${worst?.headline}${tail}.`;
  }

  const withdrawn = surfaces.find((s) => s.comparison.kind === "surface_withdrawn");
  if (withdrawn) return `The \`${withdrawn.subpath}\` entry point no longer exists.`;

  if (report.verdict === "unreadable") {
    const blocked = surfaces.filter((s) => verdictForSurface(s) === "unreadable").map((s) => s.subpath);
    return `Could not read enough of ${blocked.join(", ")} to say whether anything changed.`;
  }

  const introduced = surfaces.filter((s) => s.comparison.kind === "surface_introduced");
  if (introduced.length > 0 && surfaces.length === introduced.length) {
    return `Every surface is new at ${report.subject.to}; there is no earlier contract to compare.`;
  }

  return "No contract change a model would read differently.";
}

/**
 * Read one door at both versions and compare it.
 *
 * Extraction is per surface and never shared between them. Two doors of one
 * package routinely disagree, and that disagreement is a finding in its own
 * right — it only survives if they are read separately.
 */
async function reportSurface(
  subpath: string,
  options: ReportOptions,
  sources: { from: Awaited<ReturnType<typeof installPackage>>; to: Awaited<ReturnType<typeof installPackage>> },
  judge: Judge | undefined,
): Promise<SurfaceReport> {
  const common = { package: options.package, subpath, ...(options.surface ? { surface: options.surface } : {}) };

  const from = extractFromModule({ ...common, version: options.from, source: sources.from.source });
  const to = extractFromModule({ ...common, version: options.to, source: sources.to.source });

  const comparison = diffSurfaces(from, to);
  // Prose is only compared where both sides are readable. A missing side would
  // make every sentence look deleted.
  const prose = isPresent(to)
    ? await classifyProse(isPresent(from) ? from : null, to, judge)
    : { findings: [], skipped: [], judge: judge?.id ?? "none" };

  return { subpath, from, to, comparison, prose };
}

export async function buildReport(options: ReportOptions): Promise<Report> {
  const cacheRoot = options.cacheRoot;
  const install = (version: string) =>
    installPackage(options.package, version, {
      registry: options.registry,
      ...(cacheRoot ? { root: cacheRoot } : {}),
      ...(options.dependencyDepth !== undefined ? { depth: options.dependencyDepth } : {}),
    });

  const [from, to] = await Promise.all([install(options.from), install(options.to)]);

  // Every door either version declares. A subpath that exists at only one
  // version is still compared, because introducing or withdrawing one is itself
  // the finding.
  const declared =
    options.subpaths ??
    [
      ...new Set([
        ...exportedSubpaths(from.source.packageJson() ?? {}),
        ...exportedSubpaths(to.source.packageJson() ?? {}),
      ]),
    ].sort();

  const judge = options.judge ?? undefined;
  const surfaces = await Promise.all(
    declared.map((subpath) => reportSurface(subpath, options, { from, to }, judge)),
  );

  // The worst surface sets the verdict, but a surface that simply is not there
  // at either version says nothing and must not drag the answer to `clean`.
  const meaningful = surfaces.filter((s) => s.comparison.kind !== "surface_absent");
  const levels = (meaningful.length > 0 ? meaningful : surfaces).map(verdictForSurface);
  const verdict = levels.sort((a, b) => RANK[a] - RANK[b])[0] ?? "unreadable";

  const report: Report = {
    subject: { ecosystem: "npm", package: options.package, from: options.from, to: options.to },
    verdict,
    headline: "",
    surfaces,
    missingDependencies: [...new Set([...from.missing, ...to.missing])],
    judge: judge?.id ?? "none",
    generatedAt: new Date().toISOString(),
  };
  report.headline = headlineFor(report);
  return report;
}

/**
 * Process exit code.
 *
 * Three values, because that is what a CI step can branch on without parsing
 * anything: nothing to do, something to look at, could not tell.
 */
export function exitCodeFor(verdict: VerdictLevel): 0 | 1 | 2 {
  if (verdict === "clean") return 0;
  if (verdict === "unreadable") return 2;
  return 1;
}
