import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportedSubpaths, fsPackageSource } from "./extract/package-source.js";
import { extractFromModule } from "./extract/module.js";
import { packageDirectory } from "./testkit.js";
import { declaredDependencies } from "./audit.js";
import { buildReport, type BehaviourOptions, type Report, type VerdictLevel } from "./report.js";
import type { Registry } from "./registry/npm.js";
import type { Judge } from "./prose/judge.js";
import type { UsageProfile } from "./usage/otel.js";
import type { RepoSource } from "./blast/repo.js";

/**
 * One package, in the repository that installed it.
 *
 *     npx stantal doctor @acme/sdk
 *
 * The no-argument audit answers a consumer's question: is anything I depend on
 * about to move. This answers a **provider's**, which is the same dependency
 * read from the other end.
 *
 * A provider cannot tell their users to run `stantal <pkg> 0.52.1 0.62.1`,
 * because nobody knows two version numbers before something has already broken,
 * and by then it is not a check, it is an incident. A provider knows exactly one
 * thing: their own package name. So this takes that, works out the pair itself,
 * and reads the repository it is standing in.
 *
 * That is what makes it embeddable. It fits inside the provider's own CLI — a
 * `doctor` subcommand of their own, a postinstall, a template's `npm run check`
 * — where it runs on real consumer code, on the consumer's machine, and nothing
 * leaves it.
 *
 * **It is a narrowing, never a second implementation.** The pair goes through
 * the same `buildReport` the three-argument form uses, so a `doctor` answer and
 * a hand-typed one cannot disagree.
 */

/**
 * Why there is, or is not, a comparison to show.
 *
 * Separate values rather than a null report and a sentence, because the advice
 * differs at every one of them and three of these must never be read as a pass.
 * A provider's CLI will run this in repositories that have nothing to do with
 * them, and "we did not find your package here" arriving as `clean` would be
 * the same false all-clear this tool exists to prevent.
 */
export type DoctorStatus =
  /** The manifest does not name the package. Nothing to check, and that is a real answer. */
  | "not-a-dependency"
  /** Declared, but nothing is unpacked in node_modules. We cannot read what is not there. */
  | "not-installed"
  /** Installed, and no entry point of it hands a model tools that we could read. */
  | "no-contract"
  /** Installed at the release being checked. There is no upgrade to judge. */
  | "current"
  /** We could not resolve or compare. A gap, never a clearance. */
  | "unreachable"
  /** A real report, on a real pair. */
  | "checked";

export type DoctorResult = {
  package: string;
  directory: string;
  status: DoctorStatus;
  /** The version resolved in node_modules, or null when nothing is there. */
  installed: string | null;
  /** The release being judged: the newest published, or the one `--against` named. */
  target: string | null;
  /** The range the consumer's own manifest declares, verbatim. Null when undeclared. */
  range: string | null;
  /** The entry points that actually ship tools. Not every subpath the package exports. */
  subpaths: string[];
  tools: number;
  report: Report | null;
  /** Why, in a sentence, when there is no report. Never a substitute for `status`. */
  note: string | null;
  generatedAt: string;
};

export type DoctorOptions = {
  package: string;
  directory: string;
  registry: Registry;
  /** The release to judge against. Unset, it resolves the `latest` dist-tag. */
  target?: string;
  judge?: Judge | null;
  repo?: RepoSource;
  usage?: UsageProfile;
  behaviour?: BehaviourOptions;
  cacheRoot?: string;
};

/**
 * The declared range, read verbatim out of the consumer's manifest.
 *
 * Kept as the string rather than resolved, because the string is the thing the
 * consumer controls and the thing Layer 3 asks about. `^0.52.1` and `0.52.1`
 * install identically today and answer the range question in opposite ways.
 */
function declaredRange(manifest: Record<string, unknown>, name: string): string | null {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = manifest[field];
    if (block !== null && typeof block === "object") {
      const value = (block as Record<string, unknown>)[name];
      if (typeof value === "string") return value;
    }
  }
  return null;
}

function readManifest(directory: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function doctorPackage(options: DoctorOptions): Promise<DoctorResult> {
  const { directory, registry } = options;
  const name = options.package;
  const base = {
    package: name,
    directory,
    installed: null,
    target: null,
    range: null,
    subpaths: [] as string[],
    tools: 0,
    report: null,
    note: null,
    generatedAt: new Date().toISOString(),
  };

  const manifest = readManifest(directory);

  // A manifest we could not read is not a manifest that fails to name us. The
  // whole point of this command is that it runs in repositories we have never
  // seen, so the one thing it must not do is turn a failure to look into an
  // answer.
  if (manifest === null) {
    return { ...base, status: "unreachable", note: `no readable package.json in ${directory}` };
  }

  const range = declaredRange(manifest, name);
  if (range === null && !declaredDependencies(manifest).includes(name)) {
    return { ...base, status: "not-a-dependency", note: `${name} is not declared in this project` };
  }

  const dir = packageDirectory(name, directory);
  if (dir === null) {
    return {
      ...base,
      range,
      status: "not-installed",
      note: `${name} is declared but not present in node_modules — install before checking`,
    };
  }

  const source = fsPackageSource(dir);
  const own = source.packageJson();
  const installed = own !== null && typeof own["version"] === "string" ? own["version"] : null;
  if (own === null || installed === null) {
    return { ...base, range, status: "unreachable", note: `could not read the installed ${name} manifest` };
  }

  const subpaths: string[] = [];
  let tools = 0;
  for (const subpath of exportedSubpaths(own)) {
    const result = extractFromModule({ package: name, version: installed, subpath, source });
    if (result.present && result.contract.tools.length > 0) {
      subpaths.push(subpath);
      tools += result.contract.tools.length;
    }
  }

  const found = { ...base, range, installed, subpaths, tools };

  if (subpaths.length === 0) {
    // Deliberately not `clean`. A package whose contract we could not read is
    // where an optimistic answer does the most damage, and a provider reading
    // this about their own package is exactly the person who can tell us which
    // entry point we missed.
    return {
      ...found,
      status: "no-contract",
      note: `no entry point of ${name}@${installed} hands a model tools that we could read`,
    };
  }

  let target = options.target ?? null;
  if (target === null) {
    try {
      target = (await registry.manifest(name, "latest")).version;
    } catch (error) {
      return { ...found, status: "unreachable", note: `could not reach the registry — ${message(error)}` };
    }
  }

  if (target === installed) {
    return { ...found, target, status: "current", note: "already on the release being checked" };
  }

  try {
    const report = await buildReport({
      package: name,
      from: installed,
      to: target,
      registry,
      subpaths,
      ...(options.judge === undefined ? {} : { judge: options.judge }),
      ...(options.behaviour === undefined ? {} : { behaviour: options.behaviour }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    return { ...found, target, status: "checked", report };
  } catch (error) {
    return { ...found, target, status: "unreachable", note: `could not compare — ${message(error)}` };
  }
}

/**
 * The headline, and what the exit code derives from.
 *
 * `not-applicable` covers the three states where this repository is simply not
 * a subject: the package is not a dependency, is not installed, or ships no
 * contract we could read. It is not a pass and it is not a failure. Reporting
 * it as `clean` would let a provider count repositories they never measured.
 */
export function doctorVerdict(result: DoctorResult): VerdictLevel | "not-applicable" {
  if (result.status === "unreachable") return "unreadable";
  if (result.status === "current") return "clean";
  if (result.report !== null) return result.report.verdict;
  return "not-applicable";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
