import type { ReachKind } from "../blast/taxonomy.js";
import type { DoctorResult, DoctorStatus } from "../doctor.js";
import { doctorVerdict } from "../doctor.js";
import type { VerdictLevel } from "../report.js";

/**
 * What may leave a consumer's machine when the **provider's** tool phones home.
 *
 * `publishableReport` answers a different question, and the difference is the
 * whole reason this file exists. There, a user typed `--publish` about a report
 * they had already read, and chose to forward it. Here the user ran somebody
 * else's CLI — a provider's own `doctor` subcommand, a postinstall, a template's
 * check — and may not have read anything at all. So this payload has to be much
 * narrower than the one a person publishes on purpose, and narrow by
 * construction rather than by care.
 *
 * ### The rule
 *
 * > **The provider's own names may go, because they are already public.
 * > Nothing read out of the user's files may go, ever.**
 *
 * Tool names, parameter names, rule names and version numbers all sit in a
 * tarball anyone can `npm pack`. Sending them back discloses nothing the
 * provider could not already download. A file path, a line number, a repository
 * name or a quoted line of source is the opposite: it exists only on that
 * machine, and it is the single most sensitive thing this tool produces.
 *
 * ### Two properties, both load-bearing
 *
 * 1. **It is a rebuild, never a delete.** Every field below is named and
 *    copied. A field added to `Report` or `DoctorResult` next year is private
 *    until somebody puts it here on purpose. `publishableReport` has worked this
 *    way since it shipped and it is the reason it has never leaked, and the
 *    reason a leak here would have to be written deliberately rather than
 *    forgotten.
 * 2. **It is printed before it is sent.** A payload the user cannot see is one
 *    they cannot object to, and a provider embedding this in their own CLI is
 *    asking their users to trust a request they did not make. `summaryLines`
 *    exists so the disclosure is the same bytes as the transmission.
 */

/** One break, reduced to what the provider already knows about their own package. */
export type BreakShape = {
  /** The Layer 0 rule: `tool_removed`, `param_removed`, `param_added_required`. */
  rule: string;
  /** The provider's own tool, or `tool.param`. Public in their tarball. */
  target: string;
  /** Which entry point of their own package. Also public. */
  subpath: string;
  /**
   * How the consumer meets it: a named call site, a named parameter, or a
   * recorded call. Not *where* — the kind is the useful part and the path is
   * the dangerous one.
   */
  reach: ReachKind;
  /**
   * How many places in this repository meet it this way.
   *
   * Folded rather than listed. Once the evidence is stripped, four breaks on
   * one tool serialize as four identical objects, which reads as four separate
   * defects and is not what happened. One entry with a count says the true
   * thing and is smaller.
   */
  places: number;
};

export type DoctorSummary = {
  /** Named and versioned, so a receiver can reject a shape it does not know. */
  schema: "stantal.doctor.summary/1";
  /** The provider's package. The one thing they already knew before this ran. */
  package: string;
  /** The pair that was judged, or null when there was nothing to judge. */
  from: string | null;
  to: string | null;
  status: DoctorStatus;
  verdict: VerdictLevel | "not-applicable";
  /** Breaking structural changes, prose findings, behavioural findings. Counts only. */
  counts: { structural: number; prose: number; behavioural: number; withheld: number };
  /** How many of the provider's own tools this consumer's code names. Never which files. */
  breaks: BreakShape[];
  /**
   * How many places in the consumer's repository were touched.
   *
   * A number, never a list. "Four of your files" is a measurement the provider
   * can act on; the four names are somebody else's private code.
   */
  reaches: number;
  /** Which stantal produced this, so a receiver can tell an old shape from a new one. */
  tool: string;
  generatedAt: string;
};

/**
 * Build the payload.
 *
 * Takes the whole `DoctorResult` and returns a new object with named fields.
 * Nothing is deleted from anything; nothing is spread; there is no `...result`
 * in this function and there must never be one.
 */
export function doctorSummary(result: DoctorResult, toolVersion: string): DoctorSummary {
  const report = result.report;
  const surfaces = report?.surfaces ?? [];

  return {
    schema: "stantal.doctor.summary/1",
    package: result.package,
    from: result.installed,
    to: result.target,
    status: result.status,
    verdict: doctorVerdict(result),
    counts: {
      structural: surfaces.flatMap((s) => s.comparison.diff?.changes ?? []).filter((c) => c.breaking).length,
      prose: surfaces.flatMap((s) => s.prose.findings).length,
      behavioural: surfaces.flatMap((s) => s.behaviour?.findings ?? []).length,
      withheld: surfaces.reduce((n, s) => n + s.comparison.suppressed.length + s.prose.skipped.length, 0),
    },
    // `evidence` and `detail` are deliberately absent. `evidence` is a path in
    // the consumer's repository, and `detail` is a sentence built around it.
    breaks: foldBreaks(report?.breaks ?? []),
    reaches: report?.blast?.reaches.length ?? 0,
    tool: `stantal@${toolVersion}`,
    generatedAt: result.generatedAt,
  };
}

/**
 * One entry per distinct break, carrying how many places meet it.
 *
 * The fold happens here rather than in `Report.breaks`, because there the
 * distinct thing about each entry is the line, and the line is exactly what
 * this payload may not carry.
 */
type BreakLike = { rule: string; target: string; subpath: string; reach: ReachKind };

function foldBreaks(breaks: readonly BreakLike[]): BreakShape[] {
  const byShape = new Map<string, BreakShape>();
  for (const b of breaks) {
    // Serialized rather than joined on a separator. Every separator character
    // is one a tool name could contain, and a key collision here would merge
    // two different breaks into one count without saying so.
    const key = JSON.stringify([b.rule, b.target, b.subpath, b.reach]);
    const seen = byShape.get(key);
    if (seen === undefined) {
      byShape.set(key, { rule: b.rule, target: b.target, subpath: b.subpath, reach: b.reach, places: 1 });
    } else {
      seen.places += 1;
    }
  }
  return [...byShape.values()];
}

/**
 * The disclosure, in the words a person reads before it goes.
 *
 * Rendered from the payload itself rather than written alongside it, so the two
 * cannot drift. A disclosure that describes an older payload than the one being
 * sent is worse than none, because it is believed.
 */
export function summaryLines(summary: DoctorSummary): string[] {
  const pair = summary.from === null || summary.to === null ? summary.status : `${summary.from} → ${summary.to}`;
  return [
    `  this will be sent, and nothing else:`,
    `    package   ${summary.package}  ${pair}`,
    `    verdict   ${summary.verdict}`,
    `    counts    ${summary.counts.structural} structural, ${summary.counts.prose} prose, ${summary.counts.behavioural} behavioural, ${summary.counts.withheld} withheld`,
    `    breaks    ${summary.breaks.length} on your tools: ${
      summary.breaks.length === 0 ? "none" : summary.breaks.map((b) => `${b.rule} ${b.target} (${b.reach})`).join(", ")
    }`,
    `    reaches   ${summary.reaches} place(s) in this repository, counted, not named`,
    `  no file path, line number, or line of your code is included.`,
  ];
}
