/**
 * The shape `POST /s` accepts, and the only fields that survive it.
 *
 * Kept out of `server.mjs` so it can be tested without a bucket, a network or a
 * container. This is the privacy boundary of the whole provider direction, and
 * a boundary nothing exercises is one nobody notices breaking.
 */
/**
 * The one shape this endpoint accepts, and the only fields that survive it.
 *
 * **Rebuilt, never filtered.** The value stored is constructed field by field
 * from what arrived, so a field a newer client adds is dropped here rather than
 * written to the bucket. That is the same rule the CLI builds the payload with,
 * applied again on the receiving side, because a privacy boundary that only one
 * end enforces is enforced by whichever end has the bug.
 *
 * An unknown field is dropped rather than refused, unlike a verdict's `blast`.
 * The difference is what a mistake costs: refusing a whole summary because a
 * newer CLI added a counter would lose data a provider needs, while dropping it
 * loses nothing they had before.
 */
export const SUMMARY_SCHEMA = "stantal.doctor.summary/1";

export const STATUSES = ["not-a-dependency", "not-installed", "no-contract", "current", "unreachable", "checked"];
export const VERDICTS = [
  "clean",
  "prose-risk",
  "structurally-breaking",
  "behaviour-breaking",
  "unreadable",
  "not-applicable",
];

/**
 * What a leaked path looks like, and what a legitimate field does not.
 *
 * Written as three narrow rules rather than one broad one, because two of the
 * fields here legitimately look path-shaped and a check that flagged them would
 * reject every real summary:
 *
 * - `subpath` is the provider's own entry point, so `.`, `./ai-sdk` and
 *   `bin:tavily-mcp` are all correct and common;
 * - `package` is scoped, so `@scope/name` contains a slash.
 *
 * What none of them can ever contain is a line number, an absolute path, or a
 * Windows separator. Those are the three shapes a file reference actually has.
 */
export const LEAK_RULES = [
  /:\d+$/, // src/agent.ts:42
  /^\//, // /home/someone/app
  /^[A-Za-z]:[\\/]/, // C:\Users\someone
  /\\/, // any backslash at all
];

export function str(value, max = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export function count(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1e9 ? value : 0;
}

/**
 * Refuse a summary carrying anything read off the sender's disk.
 *
 * Belt and braces. The CLI already builds the payload so this cannot happen,
 * and that is exactly why it is worth checking here: the day it does happen it
 * will be because of a change nobody thought was about privacy, and the one
 * place guaranteed to notice is the end that never trusted the other.
 *
 * Refused rather than scrubbed, unlike an unknown field. A path in a named
 * field means the sender has a bug, and quietly cleaning up after it would hide
 * that from the only person who could fix it.
 */
export function findPath(summary) {
  const suspects = [summary.package, summary.from, summary.to];
  for (const b of summary.breaks) suspects.push(b.rule, b.target, b.subpath, b.reach);
  for (const value of suspects) {
    if (typeof value !== "string") continue;
    if (LEAK_RULES.some((rule) => rule.test(value))) return value;
  }
  return null;
}

export function rebuildSummary(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "body is not an object" };
  }
  if (value.schema !== SUMMARY_SCHEMA) {
    return { error: `schema must be "${SUMMARY_SCHEMA}"` };
  }

  const pkg = str(value.package);
  if (pkg === null) return { error: "package is missing" };
  if (!STATUSES.includes(value.status)) return { error: "status is not one of the known values" };
  if (!VERDICTS.includes(value.verdict)) return { error: "verdict is not one of the known values" };

  const counts = value.counts ?? {};
  const breaks = Array.isArray(value.breaks) ? value.breaks.slice(0, 200) : [];

  const summary = {
    schema: SUMMARY_SCHEMA,
    package: pkg,
    from: str(value.from, 64),
    to: str(value.to, 64),
    status: value.status,
    verdict: value.verdict,
    counts: {
      structural: count(counts.structural),
      prose: count(counts.prose),
      behavioural: count(counts.behavioural),
      withheld: count(counts.withheld),
    },
    breaks: breaks.map((b) => ({
      rule: str(b?.rule, 64) ?? "",
      target: str(b?.target, 200) ?? "",
      subpath: str(b?.subpath, 200) ?? "",
      reach: str(b?.reach, 64) ?? "",
      places: count(b?.places),
    })),
    reaches: count(value.reaches),
    tool: str(value.tool, 64) ?? "unknown",
    generatedAt: str(value.generatedAt, 40) ?? new Date().toISOString(),
  };

  const leaked = findPath(summary);
  if (leaked !== null) {
    return { error: "a field looks like a file path; a summary never carries anything read off your disk" };
  }
  return { summary };
}

/** `@scope/name` -> `@scope+name`, so one package is one prefix in the bucket. */
export function packageKey(name) {
  return name.replace(/\//g, "+").replace(/[^A-Za-z0-9@+._-]/g, "_");
}
