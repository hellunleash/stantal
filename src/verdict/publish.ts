import type { Report } from "../report.js";

/**
 * What may leave the machine when a verdict is published.
 *
 * Publishing is the one thing this tool does that sends anything anywhere, and
 * it is opt-in by a flag. That makes it the one place where getting the
 * contents wrong is not a bug in a report — it is a leak.
 *
 * **The rule: a verdict is about a published package, and nothing else.** Tool
 * names, descriptions and version numbers already sit in a public tarball that
 * anyone can download, so re-publishing them discloses nothing. Everything that
 * came from the user's own machine is removed here.
 */

/** Removed before a report is published, and named so the user can see it. */
export type Stripped = {
  field: string;
  detail: string;
};

export type Publishable = {
  report: Report;
  stripped: Stripped[];
};

/**
 * A report with everything private taken out.
 *
 * Layer 3's result is the whole of it today. `blast.reaches` carries paths and
 * line numbers out of the user's own repository — `src/agent.ts:42` — and those
 * are the single most sensitive thing this tool ever produces. A verdict is
 * meant to be forwarded to the package's author, who has no business knowing
 * the shape of somebody else's codebase.
 *
 * Written as a rebuild rather than a delete, so a field added to `Report` later
 * is published only when somebody puts it here on purpose.
 */
export function publishableReport(report: Report): Publishable {
  const stripped: Stripped[] = [];

  if (report.blast !== null) {
    const count = report.blast.reaches.length;
    stripped.push({
      field: "blast",
      detail:
        count === 0
          ? "the scan of your own repository, which found nothing but still names the directory"
          : `${count} reference(s) to files in your own repository, including their paths and line numbers`,
    });
  }

  return {
    report: {
      subject: report.subject,
      verdict: report.verdict,
      headline: report.headline,
      surfaces: report.surfaces,
      missingDependencies: report.missingDependencies,
      judge: report.judge,
      caller: report.caller,
      // Never published. See above.
      blast: null,
      generatedAt: report.generatedAt,
    },
    stripped,
  };
}
