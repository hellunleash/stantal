import { blastRadius, type BlastTarget } from "./blast/scan.js";
import type { RepoSource } from "./blast/repo.js";
import type { BlastResult } from "./blast/taxonomy.js";
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
  generatedAt: string;
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
  if (intents.length === 0) return null;

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
  });
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
function blastTargetsFor(surfaces: readonly SurfaceReport[]): BlastTarget[] {
  const seen = new Map<string, BlastTarget>();

  const add = (surface: string, tool: string, target: string): void => {
    const key = `${surface} ${target}`;
    if (seen.has(key)) return;
    // `tool.param` -> the parameter; a bare tool name -> no parameter. Split on
    // the first dot only, so a nested `tool.opts.retries` keeps its path.
    const rest = target.startsWith(`${tool}.`) ? target.slice(tool.length + 1) : undefined;
    seen.set(key, { label: target, surface, tool, ...(rest === undefined ? {} : { param: rest }) });
  };

  for (const s of surfaces) {
    for (const c of s.comparison.diff?.changes ?? []) add(s.subpath, c.tool, c.target);
    for (const f of s.prose.findings) add(s.subpath, f.tool, f.target);
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
            affectedVersions: [subject.to],
            targets: blastTargetsFor(surfaces),
          }),
    generatedAt: new Date().toISOString(),
  };
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
  });
}
