import { blastRadius, type BlastTarget } from "./blast/scan.js";
import type { UsageProfile } from "./usage/otel.js";
import type { RepoSource } from "./blast/repo.js";
import type { BlastResult, ReachKind } from "./blast/taxonomy.js";
import { present as wireTools, type ToolCaller } from "./behaviour/caller.js";
import type { Intent } from "./behaviour/intent.js";
import { runBehaviour, type BehaviourCache, type RunResult } from "./behaviour/run.js";
import { seedIntents } from "./behaviour/seed.js";
import { compareFindings as compareBehaviourFindings } from "./behaviour/taxonomy.js";
import { isPresent, type SurfaceResult } from "./contract/surface.js";
import type { Ecosystem, Surface } from "./contract/types.js";
import { diffSurfaces, type SurfaceComparison } from "./diff/surface.js";
import { extractFromManifest, type ManifestSource } from "./extract/manifest.js";
import { extractFromModule } from "./extract/module.js";
import { exportedSubpaths, fsPackageSource } from "./extract/package-source.js";
import { classifyProse, type ProseResult } from "./prose/classify.js";
import type { Judge } from "./prose/judge.js";
import type { ProseFinding } from "./prose/taxonomy.js";
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
   * A model demonstrably behaves differently across the pair.
   *
   * Ranked worst not because the consequence is worse but because the claim is
   * stronger. The other three levels are predictions — what a caller *would*
   * read, what *would* fail to compile. This one is an observation: a model was
   * shown both contracts and did something else on the newer one.
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
  /**
   * Layer 2's result, or null when it did not run.
   *
   * Null rather than an empty `RunResult`, which is the same invariant the
   * extractor is built around: absent is not empty. A stub would have to invent
   * a caller id, a `k` and a mode for runs that never happened, and "no model
   * was ever asked" would then be indistinguishable from "a model was asked k
   * times per side and behaved identically". Those are opposite claims, and
   * only one of them is evidence.
   */
  behaviour: RunResult | null;
};

export type Report = {
  subject: {
    ecosystem: Ecosystem;
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
  /** Which model Layer 2 replayed, or "none" when it did not run. */
  caller: string;
  /**
   * Layer 3's result, or null when no repository was supplied.
   *
   * Null rather than an empty result, for the reason absence is never empty
   * anywhere in this codebase: an empty `reaches` means "we looked and nothing
   * touches you", and that is the opposite of "nobody looked". Only one of
   * them lets a consumer stop reading.
   */
  blast: BlastResult | null;
  /**
   * Changes that break, landed on the lines that use them.
   *
   * Layer 0 knows `tavily-search` was removed. Layer 3 knows the repo names
   * `tavily-search` at `src/agent.ts:9`. Until this, the report held both and
   * joined neither, so a consumer with forty dead call sites read the same as
   * one with none: a list of changes, then a list of "reaches", in the same
   * neutral voice.
   *
   * This is the join, and it is the strongest claim the tool makes about a
   * particular consumer. Not "a model might read this differently" — *this line
   * of your code names something that is gone.* It is checkable by opening the
   * file, which is the property every finding here is supposed to have.
   *
   * Two joins, and both hold to the same standard: every entry has to survive
   * being opened.
   *
   * 1. A **breaking structural change**, met by a reach that names the thing in
   *    the consumer's own code or records it being called. A dependency reach
   *    means "you install this", and a mount means "the model chooses here";
   *    neither is a line that breaks.
   * 2. A **deleted sentence**, met by a file that still contains it word for
   *    word. Structural severity is not the gate there — a `guidance_removed`
   *    finding breaks no client, and the consumer's own copy of the deleted
   *    sentence is precisely why it belongs at the top anyway. It is also the
   *    only entry here that is usually not code: a system prompt is where a
   *    quoted sentence lives.
   */
  breaks: ConfirmedBreak[];
  generatedAt: string;
};

/** One breaking change, and one place in the consumer's code that meets it. */
export type ConfirmedBreak = {
  /** The Layer 0 rule: `tool_removed`, `param_removed`, `param_added_required`. */
  rule: string;
  /** What broke: a tool, or `tool.param`. */
  target: string;
  /** Which door it came through. */
  subpath: string;
  /** How we know this consumer meets it. */
  reach: ReachKind;
  /** `src/agent.ts:9`, or the trace file. Openable. */
  evidence: string;
  /** One sentence a person can act on. */
  detail: string;
};

/**
 * Layer 2's settings, and the switch that turns it on.
 *
 * **Opt-in by the presence of this object**, never by a key happening to be in
 * the environment. That is the one place Layer 2 deliberately differs from the
 * judge. A judge question costs one call and answers a question the rules
 * already raised, so running it whenever a key exists is free-ish and strictly
 * better. Layer 2 costs `k` calls per intent per side, plus a corpus, so an
 * available key must not be enough to start spending — the caller has to ask.
 */
export type BehaviourOptions = {
  /**
   * Null runs the report with no Layer 2 at all, exactly as a null judge runs
   * Layer 1 with no judge. A user with no key gets the same document minus the
   * section a model would have filled in, and a clean exit — never an error.
   */
  caller?: ToolCaller | null;
  /** A corpus supplied by the caller. Left unset, one is seeded per surface. */
  intents?: readonly Intent[];
  /** Runs per intent per side. Left unset, Layer 2's own default applies. */
  k?: number;
  cache?: BehaviourCache;
  /** Where a seeded corpus is cached, so a history walk pays to generate once. */
  seedCacheDir?: string;
  /** Calls in flight at once. Left unset, Layer 2's own default applies. */
  concurrency?: number;
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
  /** Left unset, Layer 2 does not run and no model is ever called. */
  behaviour?: BehaviourOptions;
  /**
   * The consumer's own repository, for Layer 3.
   *
   * Opt-in by being supplied, like Layer 2's caller. This is the only layer
   * that reads private code, so it never runs because something happened to
   * be on disk.
   */
  repo?: RepoSource;
  /**
   * Traces of what this consumer's agent actually called.
   *
   * Left unset, nothing changes: usage can only add an observed reach, never
   * remove a finding, so a report built without it is the same report with less
   * evidence rather than a different answer.
   */
  usage?: UsageProfile;
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
  // Every behavioural finding counts, `underpowered` ones included. Gating on
  // `measured` would look like caution and would in fact be a hole:
  // `new_field_used` is underpowered by construction whenever the two rates do
  // not separate, and it is both the highest-severity rule in the layer and the
  // exact shape Layer 2 was built to catch. The basis travels on the finding,
  // so a reader still sees how much it rests on.
  if ((report.behaviour?.findings.length ?? 0) > 0) return "behaviour-breaking";
  if (report.comparison.breaking) return "structurally-breaking";
  if (report.prose.findings.length > 0) return "prose-risk";

  // Nothing found. Whether that means "clean" depends entirely on whether we
  // could see. A not-comparable pair, or a side we failed to parse, is silence
  // rather than evidence.
  if (report.comparison.kind === "not_comparable") return "unreadable";
  if (report.comparison.kind === "surface_absent") return "clean";
  if (report.prose.skipped.length > 0) return "unreadable";
  // A withheld structural claim is the same kind of silence as a skipped prose
  // one, and was the one place it did not count. A run that withheld
  // `tool_removed` and then reported `clean` is the exact false reassurance
  // this product exists to prevent — the tool may well be gone, and the only
  // reason nothing was said is that we could not finish reading.
  if (report.comparison.suppressed.length > 0) return "unreadable";
  return "clean";
}

function headlineFor(report: Report): string {
  const surfaces = report.surfaces;
  const findings = surfaces.flatMap((s) => s.prose.findings);
  const structural = surfaces.flatMap((s) => s.comparison.diff?.changes ?? []).filter((c) => c.breaking);
  const behavioural = surfaces
    .flatMap((s) => s.behaviour?.findings ?? [])
    // Each run result is sorted on its own, so a flat list of several is not.
    // The headline names the worst finding in the report, not the worst one on
    // whichever door happened to be read first.
    .sort(compareBehaviourFindings);

  // Ahead of the structural branch to match `RANK`: what a model was seen doing
  // is the headline, even when the shape also moved.
  if (behavioural.length > 0) {
    const worst = behavioural[0];
    const others = behavioural.length - 1;
    const tail = others > 0 ? ` (and ${others} more)` : "";
    return `${worst?.headline}${tail}.`;
  }

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
 * Layer 2 for one door, or null when there is nothing to run it on.
 *
 * Every return of null below is a *normal* outcome, not a failure: the report
 * is produced either way and the door simply carries no behavioural section.
 * That is the same contract the judge holds, and it is what keeps the promise
 * that a first `npx` run works with no account and no key.
 */
async function behaviourFor(
  from: SurfaceResult,
  to: SurfaceResult,
  versions: { from: string; to: string },
  settings: BehaviourOptions | undefined,
): Promise<RunResult | null> {
  if (settings === undefined) return null;

  const caller = settings.caller;
  if (caller === undefined || caller === null) return null;

  // Both sides have to be readable. A side we could not read is not a model
  // behaving differently, it is us having nothing to put in front of the model
  // — and showing it an empty contract would manufacture `call_abandoned` on
  // every intent.
  if (!isPresent(from) || !isPresent(to)) return null;
  // Either side being empty, not just the older one. A newer version with no
  // tools left leaves the model nothing to call, so `call_abandoned` fires on
  // every intent and the verdict becomes behaviour-breaking — when the real
  // event is that every tool was removed, which Layer 0 already reports as a
  // structural break. Paying k calls per intent per side to rediscover that is
  // the expensive way to be told something the contract says on its face.
  if (from.contract.tools.length === 0 || to.contract.tools.length === 0) return null;

  // A contract that did not change is skipped rather than measured, and this is
  // a correctness guard before it is a cost one. Model output is stochastic, so
  // the same tools shown to the same model twice can produce two different
  // rates by chance — and a difference in rates is the only thing this layer
  // looks at. Comparing a contract against itself can manufacture a finding and
  // can never earn one. Compared on the wire form because that is exactly what
  // the model sees; anything the model is not shown cannot move what it does.
  if (JSON.stringify(wireTools(from.contract)) === JSON.stringify(wireTools(to.contract))) {
    return null;
  }

  const intents =
    settings.intents ??
    (await seedIntents({
      // The anchor is the older side, never the newer one. Seeding from the
      // contract under test writes the request to match the prose being
      // evaluated, and the measurement becomes circular.
      anchor: from.contract,
      caller,
      ...(settings.seedCacheDir !== undefined ? { cacheDir: settings.seedCacheDir } : {}),
    }));
  if (intents.length === 0) {
    // Asked for, and it could not run. Reported rather than skipped silently:
    // `behaviour: null` means nobody asked, and the two are opposite claims. A
    // user who typed `--behaviour` and got nothing back has no way to tell
    // which one happened.
    //
    // Found on a real contract, on a run that produced no Layer 2 section and
    // said `caller: none`, with nothing anywhere to say why. Seeding the same
    // anchor with the same model a few minutes later returned 137 intents, so
    // whatever happened was not a property of the contract — which is exactly
    // why silence was the wrong output. The one thing a skip must never do is
    // read like a model that was never configured.
    return {
      findings: [],
      skipped: [
        {
          intentId: "(corpus)",
          reason: `${caller.id} did not propose a corpus for this contract, so nothing could be measured`,
        },
      ],
      caller: caller.id,
      k: settings.k ?? 5,
      mode: "full",
      replayed: 0,
      corpus: 0,
      stats: { hits: 0, misses: 0, writes: 0 },
    };
  }

  return runBehaviour({
    from: { version: versions.from, contract: from.contract },
    to: { version: versions.to, contract: to.contract },
    intents,
    caller,
    ...(settings.k !== undefined ? { k: settings.k } : {}),
    ...(settings.cache !== undefined ? { cache: settings.cache } : {}),
    ...(settings.concurrency !== undefined ? { concurrency: settings.concurrency } : {}),
  });
}

/**
 * Compare one door, given both sides already extracted.
 *
 * Everything a layer does after extraction — diff, classify, put it in front of
 * a model — is written against `SurfaceResult` and knows nothing about where
 * the contract came from. Keeping that seam explicit is what lets a contract
 * that never reached a registry go through the same pipeline as a published
 * one, with no second implementation of the layers to keep in step.
 */
async function compareSurfaces(
  subpath: string,
  from: SurfaceResult,
  to: SurfaceResult,
  versions: { from: string; to: string },
  judge: Judge | undefined,
  behaviour: BehaviourOptions | undefined,
): Promise<SurfaceReport> {
  const comparison = diffSurfaces(from, to);
  // Prose is only compared where both sides are readable. A missing side would
  // make every sentence look deleted.
  const prose = isPresent(to)
    ? await classifyProse(isPresent(from) ? from : null, to, judge)
    : { findings: [], skipped: [], judge: judge?.id ?? "none" };

  return {
    subpath,
    from,
    to,
    comparison,
    prose,
    behaviour: await behaviourFor(from, to, versions, behaviour),
  };
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

  return compareSurfaces(
    subpath,
    extractFromModule({ ...common, version: options.from, source: sources.from.source }),
    extractFromModule({ ...common, version: options.to, source: sources.to.source }),
    { from: options.from, to: options.to },
    judge,
    options.behaviour,
  );
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

  return foldReport({
    subject: { ecosystem: "npm", package: options.package, from: options.from, to: options.to },
    surfaces,
    missingDependencies: [...new Set([...from.missing, ...to.missing])],
    judge,
    caller: options.behaviour?.caller ?? null,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
}

/**
 * Where a breaking change meets a line of the consumer's code.
 *
 * The join both halves were built for and neither could make alone. Layer 0
 * says what broke; Layer 3 says where this consumer touches it. Kept apart they
 * are two lists in the same neutral voice, and the reader has to do the
 * crossing by eye — which is the work a tool should be doing. A consumer with
 * forty dead call sites read exactly like a consumer with none.
 *
 * This is the strongest claim the product makes about a particular consumer.
 * Not "a model might read this differently". *This line of your code names
 * something that is gone.* Checkable by opening the file, which is the property
 * every claim here is meant to have.
 *
 * Deliberately narrow, because the value is that it cannot be argued with:
 *
 * - only **breaking** structural changes. A prose finding is a claim about how
 *   a model reads, and this section is for claims about code;
 * - only reaches that **name the thing** — a call site, a parameter reference,
 *   or a recorded call. `dependency` says "you install this" and
 *   `model_consumer` says "the model chooses here"; neither is a line that
 *   stops working, and listing them here would blunt the one section whose
 *   whole worth is that every entry survives being checked.
 */
function confirmedBreaks(report: Report): ConfirmedBreak[] {
  const blast = report.blast;
  if (blast === null) return [];

  const NAMES: ReadonlySet<ReachKind> = new Set<ReachKind>([
    "tool_reference",
    "param_reference",
    "observed_call",
    // The same claim as `tool_reference`, in the vocabulary an HTTP API uses.
    // Leaving it out would mean an API change could never break anybody's code,
    // which is the opposite of true.
    "endpoint_reference",
  ]);

  const out: ConfirmedBreak[] = [];
  const seen = new Set<string>();

  for (const surface of report.surfaces) {
    for (const change of surface.comparison.diff?.changes ?? []) {
      if (!change.breaking) continue;

      for (const reach of blast.reaches) {
        if (!NAMES.has(reach.kind)) continue;
        // A tool-level change meets any reach naming that tool. A parameter
        // change meets only a reach naming that exact parameter, because
        // naming the tool says nothing about which field is passed.
        const meets =
          change.target === change.tool ? reach.target === change.tool : reach.target === change.target;
        if (!meets) continue;

        const key = `${change.rule}|${change.target}|${reach.evidence}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          rule: change.rule,
          target: change.target,
          subpath: surface.subpath,
          reach: reach.kind,
          evidence: reach.evidence,
          detail:
            reach.kind === "observed_call"
              ? `${change.note}, and your traces record it being called`
              : // An endpoint reach already carries the honest phrasing, and it
                // is the one kind where "this line names it" can be false: a
                // resource match means the line names the family the operation
                // belongs to, not the operation. Flattening the two would put
                // an overstatement in the section whose whole worth is that
                // every entry survives being opened.
                reach.kind === "endpoint_reference"
                ? `${change.note}, and ${reach.detail}`
                : `${change.note}, and this line names it`,
        });
      }
    }
  }

  // The prose half, and the sharpest entry this section has.
  //
  // Every other break here joins a structural change to a line that *names*
  // something. This one joins a deleted sentence to a line that *contains* it,
  // word for word. It is a stronger claim than a word match — a name can appear
  // for a dozen reasons and a full sentence of guidance appears for one — and it
  // is the case nothing else in a toolchain can see, because both halves of the
  // mismatch are prose.
  //
  // Structural severity is not the gate here; the match is. A `guidance_removed`
  // finding is not a breaking change to any client, and that is exactly why the
  // consumer's own copy of the deleted sentence is worth putting at the top.
  for (const surface of report.surfaces) {
    for (const finding of surface.prose.findings) {
      for (const reach of blast.reaches) {
        if (reach.kind !== "stale_quote" || reach.target !== finding.target) continue;

        const key = `${finding.rule}|${finding.target}|${reach.evidence}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          rule: finding.rule,
          target: finding.target,
          subpath: surface.subpath,
          reach: reach.kind,
          evidence: reach.evidence,
          detail: reach.detail,
        });
      }
    }
  }

  return out;
}

/**
 * Every finding in the report, reduced to what Layer 3 can look for.
 *
 * Structural changes and prose findings both reduce to the same three fields,
 * which is the point: what reaches a consumer does not depend on which rule
 * raised it. A scanner that switched on rule names would need editing every
 * time a rule was added.
 *
 * De-duplicated, because one parameter can be named by a structural change and
 * a prose finding at once, and scanning a repo twice for the same word produces
 * two identical reaches and no extra information.
 */
/**
 * The sentence a finding says was deleted, when it says one was.
 *
 * Three of Layer 1's rules are about text that used to be there and is not.
 * Their `quote` is that text, verbatim from the older version. The other rules
 * quote something that is still present, and handing one of those to the scan
 * would report a consumer as stale for holding a sentence the contract still
 * contains — the exact opposite of the claim.
 *
 * Checked against the newer text as well, rather than trusted. The classifier
 * compares whole sentences; a sentence it treated as removed can still survive
 * inside a rewritten one, and this reach is only worth having because it cannot
 * be argued with.
 */
function deletedSentence(finding: ProseFinding): string | null {
  const REMOVES: ReadonlySet<string> = new Set(["guidance_removed", "mode_switch_changed", "example_removed"]);
  if (!REMOVES.has(finding.rule)) return null;
  const quote = finding.evidence.quote;
  if (quote === null) return null;
  const after = finding.evidence.after;
  if (after !== null && after.replace(/\s+/g, " ").includes(quote.replace(/\s+/g, " ").trim())) return null;
  return quote;
}

/** Mutable while it is being assembled, frozen into `BlastTarget` on the way out. */
type PendingTarget = BlastTarget & { quotes?: string[] };

function blastTargetsFor(surfaces: readonly SurfaceReport[]): BlastTarget[] {
  const seen = new Map<string, PendingTarget>();

  // Aliases belong to a tool, and a finding names a tool, so they are looked up
  // once per surface rather than threaded through every caller of `add`.
  const aliasesByTool = new Map<string, readonly string[]>();
  for (const s of surfaces) {
    for (const side of [s.from, s.to]) {
      if (!isPresent(side)) continue;
      for (const t of side.contract.tools) {
        if (t.aliases !== undefined && t.aliases.length > 0) {
          aliasesByTool.set(`${s.subpath}\u0000${t.name}`, t.aliases);
        }
      }
    }
  }

  const add = (surface: string, tool: string, target: string, quote?: string | null): void => {
    const key = `${surface} ${target}`;
    const existing = seen.get(key);
    if (existing !== undefined) {
      // The same target can arrive from Layer 0 and Layer 1 both, and only one
      // of them carries a deleted sentence. Merged rather than skipped, or the
      // quote would be lost to whichever layer happened to be read first.
      if (quote !== undefined && quote !== null) {
        existing.quotes = [...new Set([...(existing.quotes ?? []), quote])];
      }
      return;
    }
    // `tool.param` -> the parameter; a bare tool name -> no parameter. Split on
    // the first dot only, so a nested `tool.opts.retries` keeps its path.
    const rest = target.startsWith(`${tool}.`) ? target.slice(tool.length + 1) : undefined;
    const aliases = aliasesByTool.get(`${surface}\u0000${tool}`);
    seen.set(key, {
      label: target,
      surface,
      tool,
      ...(rest === undefined ? {} : { param: rest }),
      ...(aliases === undefined ? {} : { aliases }),
      ...(quote === undefined || quote === null ? {} : { quotes: [quote] }),
    });
  };

  for (const s of surfaces) {
    for (const c of s.comparison.diff?.changes ?? []) add(s.subpath, c.tool, c.target);
    for (const f of s.prose.findings) add(s.subpath, f.tool, f.target, deletedSentence(f));
    for (const f of s.behaviour?.findings ?? []) {
      // Behavioural targets are `tool` or `tool.field`; the tool is the head.
      const tool = f.target.split(".")[0] ?? f.target;
      if (tool.length > 0 && tool !== "(any)") add(s.subpath, tool, f.target);
    }
  }

  return [...seen.values()];
}

/**
 * Many doors -> one answer.
 *
 * Split out from `buildReport` so every producer of surfaces folds them the
 * same way. The verdict is what a CI job branches on, and two entry points
 * ranking it differently would be a silent disagreement about what "clean"
 * means.
 */
function foldReport(input: {
  subject: Report["subject"];
  surfaces: SurfaceReport[];
  missingDependencies: string[];
  judge: Judge | undefined;
  caller: ToolCaller | null;
  /** The consumer's repo, when Layer 3 was asked for. */
  repo?: RepoSource | undefined;
  /** What the consumer's agent actually called, when traces were supplied. */
  usage?: UsageProfile | undefined;
}): Report {
  const { subject, surfaces, missingDependencies, judge } = input;

  // The worst surface sets the verdict, but a surface that simply is not there
  // at either version says nothing and must not drag the answer to `clean`.
  const meaningful = surfaces.filter((s) => s.comparison.kind !== "surface_absent");
  const levels = (meaningful.length > 0 ? meaningful : surfaces).map(verdictForSurface);
  const verdict = levels.sort((a, b) => RANK[a] - RANK[b])[0] ?? "unreadable";

  const report: Report = {
    subject,
    verdict,
    headline: "",
    surfaces,
    missingDependencies,
    judge: judge?.id ?? "none",
    // Named only when Layer 2 actually ran on at least one door. Reporting the
    // configured caller would claim a model was consulted on runs where every
    // door was skipped — unchanged contract, unreadable side, empty corpus —
    // and "a model looked and found nothing" is the opposite claim to "nothing
    // was measured". "none" therefore covers not asked for, asked for with no
    // key, and asked for but nothing to ask about.
    caller: surfaces.some((s) => s.behaviour !== null) ? (input.caller?.id ?? "none") : "none",
    // Layer 3 runs last, on the findings the earlier layers produced. It is the
    // only layer that reads private code, so it runs only when a repo was
    // handed over — never because one happened to be the working directory.
    //
    // The affected version is the newer side, which is where every finding in
    // this report was measured. A wider window is a property of a history walk,
    // not of one pair, and claiming one here would assert a range nobody
    // checked.
    blast:
      input.repo === undefined
        ? null
        : blastRadius({
            repo: input.repo,
            package: subject.package,
            ecosystem: subject.ecosystem,
            affectedVersions: [subject.to],
            targets: blastTargetsFor(surfaces),
            ...(input.usage === undefined ? {} : { usage: input.usage }),
          }),
    breaks: [],
    generatedAt: new Date().toISOString(),
  };
  // After the blast, because it is the join of the two.
  report.breaks = confirmedBreaks(report);
  report.headline = headlineFor(report);
  return report;
}

/**
 * A contract that never went to a registry.
 *
 * The registry path answers "should I take this upgrade" for a consumer. This
 * one answers the provider's question instead: *I* am about to ship this — what
 * will it do to the models already calling me. That release does not exist on
 * npm yet, and often never will, so there is nothing to install and no version
 * to resolve. What there is, is the tool manifest, on both sides.
 *
 * The layers are the same objects, not a parallel implementation. Only the two
 * lines that produce the sides differ.
 */
/**
 * One side of a manifest comparison.
 *
 * `sources` rather than one text, because a contract is not always one file: a
 * host that generates schemas from its routes and keeps the prose somewhere
 * editable ships two, and what a model receives is the merge. Catalog first.
 */
export type ManifestSide = {
  version: string;
  sources: readonly ManifestSource[];
};

export type ManifestReportOptions = {
  from: ManifestSide;
  to: ManifestSide;
  /** What to call the subject. A file carries no registry identity of its own. */
  package: string;
  ecosystem?: Ecosystem;
  surface?: Surface;
  /** Where a descriptor's fields live when a document nests them. */
  fieldsKey?: string;
  /** Tools the runtime withholds, as a predicate the caller states. */
  excludeWhen?: readonly { key: string; value: string }[];
  /** Null runs Layer 1 with no judge: findings stand, marked unconfirmed. */
  judge?: Judge | null;
  /** Left unset, Layer 2 does not run and no model is ever called. */
  behaviour?: BehaviourOptions;
  /** The consumer's own repository, for Layer 3. Left unset, nothing is read. */
  repo?: RepoSource;
  /**
   * Traces of what this consumer's agent actually called.
   *
   * Left unset, nothing changes: usage can only add an observed reach, never
   * remove a finding, so a report built without it is the same report with less
   * evidence rather than a different answer.
   */
  usage?: UsageProfile;
};

export async function buildManifestReport(options: ManifestReportOptions): Promise<Report> {
  const { package: pkg, ecosystem = "http" } = options;
  const judge = options.judge ?? undefined;

  const side = (s: ManifestSide) =>
    extractFromManifest({
      sources: s.sources,
      package: pkg,
      version: s.version,
      ecosystem,
      ...(options.surface ? { surface: options.surface } : {}),
      ...(s.sources[0]?.origin !== undefined ? { origin: s.sources[0].origin } : {}),
      ...(options.fieldsKey !== undefined ? { fieldsKey: options.fieldsKey } : {}),
      ...(options.excludeWhen !== undefined ? { excludeWhen: options.excludeWhen } : {}),
    });

  // One contract is one surface, so the subpath is the document it came from
  // rather than an exports subpath. Named after the catalog, since that is the
  // document that defines the tool set.
  const subpath = options.to.sources[0]?.origin ?? "manifest";

  const surface = await compareSurfaces(
    subpath,
    side(options.from),
    side(options.to),
    { from: options.from.version, to: options.to.version },
    judge,
    options.behaviour,
  );

  return foldReport({
    subject: { ecosystem, package: pkg, from: options.from.version, to: options.to.version },
    surfaces: [surface],
    // Nothing was installed, so nothing could be missing. Reporting a dependency
    // gap here would claim a narrowed read that did not happen.
    missingDependencies: [],
    judge,
    caller: options.behaviour?.caller ?? null,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
}

/**
 * Two contracts that were read rather than inferred.
 *
 * The live MCP reader hands back a `SurfaceResult` directly. There is no
 * package to install, no entry point to resolve and no document to parse, so
 * the two lines that produce the sides in every other builder have already
 * happened by the time this is called.
 *
 * Everything after that point is shared with the other builders on purpose.
 * The diff, the classifier, Layer 2, Layer 3 and the fold are the same objects,
 * so a finding about a running server is the same kind of claim, ranked the
 * same way, as a finding about a tarball.
 */
export type SurfacePairOptions = {
  from: SurfaceResult;
  to: SurfaceResult;
  /** What to call the subject. A running server carries no registry identity. */
  package: string;
  /** Labels for the two sides. A URL or a command, not a semver. */
  versions: { from: string; to: string };
  /** The name of the thing being compared, used as the surface label. */
  subpath?: string;
  ecosystem?: Ecosystem;
  judge?: Judge | null;
  behaviour?: BehaviourOptions;
  repo?: RepoSource;
  usage?: UsageProfile;
};

export async function buildSurfacePairReport(options: SurfacePairOptions): Promise<Report> {
  const judge = options.judge ?? undefined;
  const surface = await compareSurfaces(
    options.subpath ?? "mcp-server",
    options.from,
    options.to,
    options.versions,
    judge,
    options.behaviour,
  );

  return foldReport({
    subject: {
      ecosystem: options.ecosystem ?? "http",
      package: options.package,
      from: options.versions.from,
      to: options.versions.to,
    },
    surfaces: [surface],
    // Nothing was installed, so nothing could be missing. Reporting a
    // dependency gap here would claim a narrowed read that never happened.
    missingDependencies: [],
    judge,
    caller: options.behaviour?.caller ?? null,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
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

/**
 * What this report found, per layer, folded across every surface.
 *
 * Kept in four separate numbers rather than one total. A structural change and
 * a prose finding are not the same claim, and `withheld` is not a finding at
 * all — it is a claim we declined to make. Summing them would inflate the count
 * and let a reader mistake our silence for our evidence.
 */
export function countFindings(report: Report): {
  structural: number;
  prose: number;
  behavioural: number;
  withheld: number;
} {
  const surfaces = report.surfaces;
  return {
    structural: surfaces.flatMap((s) => s.comparison.diff?.changes ?? []).filter((c) => c.breaking).length,
    prose: surfaces.flatMap((s) => s.prose.findings).length,
    behavioural: surfaces.flatMap((s) => s.behaviour?.findings ?? []).length,
    withheld: surfaces.reduce((n, s) => n + s.comparison.suppressed.length + s.prose.skipped.length, 0),
  };
}

/**
 * A build that has not been published yet, against a release that has.
 *
 * The provider's own gate, and the one case neither other entry point serves.
 * `buildReport` needs both sides on a registry, and by the time a release is
 * there it is too late for this question. `buildManifestReport` works on a
 * contract already serialized to JSON, which a host produces and an ordinary
 * npm package does not.
 *
 * So a provider whose descriptors live in shipped JavaScript — most of them —
 * had no way to ask "what will this release do to the models already calling
 * me" while the answer still cost minutes to act on. This is that path: read
 * `dist/` off the disk, fetch the last release, compare.
 */
export type LocalReportOptions = {
  /** The unpublished build: a package directory with a manifest and its `dist`. */
  directory: string;
  /** What to call the local side in the report. */
  label?: string;
  /** The published release to compare against. */
  against: { package: string; version: string; registry: Registry };
  cacheRoot?: string;
  dependencyDepth?: number;
  subpaths?: readonly string[];
  surface?: Surface;
  judge?: Judge | null;
  behaviour?: BehaviourOptions;
  repo?: RepoSource;
  /**
   * Traces of what this consumer's agent actually called.
   *
   * Left unset, nothing changes: usage can only add an observed reach, never
   * remove a finding, so a report built without it is the same report with less
   * evidence rather than a different answer.
   */
  usage?: UsageProfile;
};

export async function buildLocalReport(options: LocalReportOptions): Promise<Report> {
  const { directory, against } = options;
  const judge = options.judge ?? undefined;
  const local = fsPackageSource(directory);

  const manifest = local.packageJson();
  // The directory has to look like a package. Failing here with the path is
  // better than reporting every tool as removed because `dist/` was one level
  // further down than the caller thought.
  if (manifest === null) {
    throw new Error(`${directory} has no readable package.json — point this at the package root, not its dist`);
  }

  const pkg = against.package;
  const declaredName = typeof manifest["name"] === "string" ? manifest["name"] : null;
  if (declaredName !== null && declaredName !== pkg) {
    throw new Error(`${directory} is ${declaredName}, but --against names ${pkg}`);
  }

  const published = await installPackage(pkg, against.version, {
    registry: against.registry,
    ...(options.cacheRoot ? { root: options.cacheRoot } : {}),
    ...(options.dependencyDepth !== undefined ? { depth: options.dependencyDepth } : {}),
  });

  const label = options.label ?? (typeof manifest["version"] === "string" ? `${manifest["version"]} (local)` : "local");

  // Every door either side declares. A subpath added by the unpublished build
  // is exactly the kind of change worth seeing, so the local manifest is read
  // for doors too rather than trusting the published one to list them all.
  const declared =
    options.subpaths ??
    [
      ...new Set([
        ...exportedSubpaths(published.source.packageJson() ?? {}),
        ...exportedSubpaths(manifest),
      ]),
    ].sort();

  const common = { package: pkg, ...(options.surface ? { surface: options.surface } : {}) };

  const surfaces = await Promise.all(
    declared.map((subpath) =>
      compareSurfaces(
        subpath,
        extractFromModule({ ...common, subpath, version: against.version, source: published.source }),
        extractFromModule({ ...common, subpath, version: label, source: local }),
        { from: against.version, to: label },
        judge,
        options.behaviour,
      ),
    ),
  );

  return foldReport({
    subject: { ecosystem: "npm", package: pkg, from: against.version, to: label },
    surfaces,
    missingDependencies: published.missing,
    judge,
    caller: options.behaviour?.caller ?? null,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
}
