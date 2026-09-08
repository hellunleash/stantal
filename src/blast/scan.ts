import semver from "semver";
import type { PackageJson } from "../extract/package-source.js";
import { isProseFile, type RepoSource } from "./repo.js";
import type { Ecosystem } from "../contract/types.js";
import { compareReaches, type BlastNote, type BlastResult, type Filtered, type Reach } from "./taxonomy.js";
import { GENERATED_MARKER } from "../emit/vitest.js";
import { callsOf, type UsageProfile } from "../usage/otel.js";

/**
 * One thing a finding is about, reduced to what a scan can look for.
 *
 * Deliberately not the finding itself. Layer 3 should not know the prose
 * taxonomy or the structural one — what reaches a consumer is the same question
 * whether the finding came from a deleted sentence or a removed parameter, and
 * a scanner that switched on rule names would need editing every time a rule
 * was added.
 */
export type BlastTarget = {
  /** The finding's own target, reported back verbatim so it can be matched up. */
  label: string;
  /** The door the finding sits on: ".", "./ai-sdk", "bin:name", or a filename. */
  surface: string;
  tool: string;
  /** Set when the finding is about one parameter. */
  param?: string;
  /**
   * Other strings that identify this same operation in the consumer's source.
   *
   * Carried down from the contract rather than derived here, for the same
   * reason the deleted sentences are: only the reader knows what the operation
   * is called anywhere other than in its own contract.
   */
  aliases?: readonly string[];
  /**
   * Sentences the newer version of the contract deleted.
   *
   * Handed down rather than derived here, because only Layer 1 knows what the
   * text used to say. The scan's job is the other half: does any file in this
   * repository still contain one of them.
   */
  quotes?: readonly string[];
};

export type BlastOptions = {
  repo: RepoSource;
  /** The package the findings are about. */
  package: string;
  /**
   * How this contract is distributed, which decides whether the manifest has
   * anything to say about it.
   *
   * For a package the manifest is the first and strongest filter: if the
   * project does not depend on it, nothing in it can reach them, and that is an
   * evidenced answer.
   *
   * For an HTTP API the same reasoning is simply wrong. Nobody declares
   * Stripe's API in a `package.json` — they install an SDK under some other
   * name, or they call `fetch`. Applying the dependency gate there filtered
   * every finding as `not_a_dependency` before a single file was read, which
   * is a confident claim of "nothing reaches you" about a repository that was
   * never scanned. Found by pointing this at a real Stripe consumer.
   *
   * Defaults to `npm`, so every existing caller keeps the behaviour it had.
   */
  ecosystem?: Ecosystem;
  /**
   * Versions the findings are present in.
   *
   * Compared against the *declared range*, not the installed version. A caret
   * range that resolves clean today still admits the defect on the next
   * install, and a consumer deciding whether they are exposed needs to know
   * that before it happens rather than after.
   */
  affectedVersions: readonly string[];
  targets: readonly BlastTarget[];
  /**
   * What the consumer's agent actually called, from traces.
   *
   * Optional, and additive only: a profile can turn a finding into an observed
   * reach and can never filter one out. Absence from a trace window is not
   * evidence that a tool is unused.
   */
  usage?: UsageProfile | undefined;
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function declaredRange(pkg: PackageJson, name: string): { field: string; range: string } | null {
  for (const field of DEPENDENCY_FIELDS) {
    const block = pkg[field];
    if (typeof block !== "object" || block === null) continue;
    const range = (block as Record<string, unknown>)[name];
    if (typeof range === "string") return { field, range };
  }
  return null;
}

/**
 * Which subpath of the package this specifier imports.
 *
 * `@scope/name` and `name` both map to `.`; anything after the package name
 * becomes `./rest`. Returns null when the specifier is a different package —
 * `@vendoai/vendo-extra` must not match `@vendoai/vendo`, which a plain
 * `startsWith` would happily do.
 */
export function subpathOf(specifier: string, pkg: string): string | null {
  if (specifier === pkg) return ".";
  if (!specifier.startsWith(`${pkg}/`)) return null;
  return `./${specifier.slice(pkg.length + 1)}`;
}

/** `from "x"`, `require("x")`, `import("x")`. Textual, and honest about it. */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g;

/** Enough of the sentence to recognise, short enough for one terminal line. */
function truncateQuote(quote: string): string {
  const flat = normalise(quote).trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Every line where a bare word appears, as a whole word. */
function wordLines(text: string, word: string): number[] {
  const out: number[] = [];
  const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  text.split("\n").forEach((line, i) => {
    if (pattern.test(line)) out.push(i + 1);
  });
  return out;
}

/**
 * A sentence long enough that finding it twice is not a coincidence.
 *
 * Measured against what a deleted guidance sentence actually looks like:
 * *"Pass `slot` only when the request names a particular place"* is 56
 * characters and 10 words. The floor is set below that and well above the
 * fragments that appear everywhere — "the request", "an existing app", "if it
 * is not set". Under it, a match would be an accident being reported as
 * evidence, which is the one thing this reach cannot afford: its whole worth is
 * that the reader opens the line and agrees.
 */
const QUOTE_MIN_CHARS = 40;
const QUOTE_MIN_WORDS = 6;

/** Collapse runs of whitespace, so a wrapped prompt still matches one sentence. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ");
}

export function isQuotable(sentence: string): boolean {
  const flat = normalise(sentence).trim();
  return flat.length >= QUOTE_MIN_CHARS && flat.split(" ").length >= QUOTE_MIN_WORDS;
}

/**
 * Where a normalised sentence appears in a text, as a line in the original.
 *
 * The search runs on whitespace-collapsed text so a sentence wrapped across
 * three lines of a prompt still matches, but the answer has to be a line in the
 * file the reader will open. So the map back to the original offset is built as
 * the normalisation happens rather than reconstructed afterwards.
 */
function quoteLines(text: string, needle: string): number[] {
  const flat: string[] = [];
  const origin: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      if (inSpace) continue;
      inSpace = true;
      flat.push(" ");
      origin.push(i);
      continue;
    }
    inSpace = false;
    flat.push(ch);
    origin.push(i);
  }

  const haystack = flat.join("");
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const start = origin[at];
    if (start !== undefined) out.push(lineOf(text, start));
  }
  return out;
}

/**
 * Every line where an alias appears, bounded so a prefix is not a match.
 *
 * `wordLines` cannot be reused. It wraps the pattern in `\-b` at both ends,
 * and an alias routinely starts with a character that is not a word character:
 * `/v1/account_sessions` starts with a slash, `.charges` with a dot. A leading
 * boundary there can never match, so every path would be silently invisible.
 *
 * The trailing boundary is the one that matters and it is kept. Without it
 * `.billing` matches inside `.billingPortal`, which was measured against real
 * consumer code: it pulled in twenty-five billing endpoints from a project that
 * only touches the portal.
 */
function aliasLines(text: string, alias: string): number[] {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /^\w/.test(alias) ? "\\b" : "";
  const tail = /\w$/.test(alias) ? "\\b" : "";
  const pattern = new RegExp(`${lead}${escaped}${tail}`);

  const out: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (pattern.test(line)) out.push(i + 1);
  });
  return out;
}

/**
 * Which of a consumer's code a set of findings actually reaches.
 *
 * Reads only: nothing is written, nothing is executed, and nothing leaves the
 * machine. The one layer that touches private code is also the one that needs
 * no network at all.
 */
export function blastRadius(options: BlastOptions): BlastResult {
  const { repo, package: pkg, affectedVersions, targets, usage } = options;
  // An HTTP API is not something a manifest can declare, so the whole
  // dependency question is skipped rather than answered wrongly.
  const distributed = (options.ecosystem ?? "npm") !== "http";

  const reaches: Reach[] = [];
  const filtered: Filtered[] = [];
  const notes: BlastNote[] = [];

  // --- is the package even here, and does the range admit the defect? -------

  const manifest = distributed ? repo.packageJson() : undefined;
  if (manifest === undefined) {
    // Nothing to say. Not a gap either: there is no manifest entry that could
    // have existed, so silence here narrows nothing.
  } else if (manifest === null) {
    // No manifest is a gap, never "not a dependency". A workspace member, a
    // Deno project, or a repo we were pointed at one directory too deep all
    // land here, and all of them may still use the package.
    notes.push({ where: "package.json", detail: "no readable manifest, so dependency reach is unknown" });
  } else {
    const declared = declaredRange(manifest, pkg);
    if (declared === null) {
      // Evidenced: there is a manifest and it does not name the package.
      for (const target of targets) {
        filtered.push({ target: target.label, kind: "not_a_dependency", reason: `${pkg} is not a declared dependency` });
      }
      return {
        reaches,
        filtered,
        notes,
        scanned: { files: 0, bytes: 0 },
      };
    }

    const usable = affectedVersions.filter((v) => semver.valid(v) !== null);
    const admits =
      semver.validRange(declared.range) === null || usable.length === 0
        ? null
        : usable.some((v) => semver.satisfies(v, declared.range));

    if (admits === null) {
      // `workspace:*`, `file:../x`, a git url. Real and common, and not
      // something to guess at: an unparseable range is reported as unknown
      // rather than resolved to either answer.
      notes.push({
        where: "package.json",
        detail: `"${declared.range}" is not a comparable semver range, so version reach is unknown`,
      });
    } else if (admits) {
      reaches.push({
        kind: "dependency",
        target: pkg,
        evidence: `package.json (${declared.field})`,
        detail: `"${declared.range}" admits ${usable.filter((v) => semver.satisfies(v, declared.range)).length} affected version(s)`,
      });
    } else {
      for (const target of targets) {
        filtered.push({
          target: target.label,
          kind: "range_excludes",
          reason: `"${declared.range}" admits no affected version`,
        });
      }
      return { reaches, filtered, notes, scanned: { files: 0, bytes: 0 } };
    }
  }

  // --- what the repo actually imports, and what it names --------------------

  const importedSubpaths = new Map<string, string>(); // subpath -> evidence
  const toolFiles = new Map<string, Array<{ path: string; line: number }>>();
  const aliasFiles = new Map<string, Array<{ path: string; line: number }>>();
  const quoteFiles = new Map<string, Array<{ path: string; line: number }>>();
  let files = 0;
  let bytes = 0;

  const toolNames = [...new Set(targets.map((t) => t.tool))];
  const aliasNames = [...new Set(targets.flatMap((t) => t.aliases ?? []))];

  // Deduplicated and normalised once, because two findings on one tool often
  // carry the same deleted sentence and the search is the expensive part.
  const quotes = [
    ...new Set(
      targets.flatMap((t) => (t.quotes ?? []).filter(isQuotable).map((q) => normalise(q).trim())),
    ),
  ];

  // The traces, when they live inside the repo being scanned. Compared as a
  // repo-relative POSIX path, which is what `files()` yields.
  const tracePath =
    usage === undefined ? null : usage.source.replace(/^\.\//, "").split("\\").join("/");

  for (const path of repo.files()) {
    const text = repo.read(path);
    if (text === null) {
      notes.push({ where: path, detail: "listed but could not be read" });
      continue;
    }

    // Our own emitted suite is not one of the consumer's call sites. It names
    // every tool it pins, by construction, so scanning it turns one generated
    // file into dozens of reaches and buries the handful that are real — the
    // same failure as scanning a lockfile, found the same way, by running it.
    //
    // Not a note: a note means we could not read something, and would stop
    // `canClaimUnaffected` from ever being true. We read this one and know
    // exactly what it is.
    if (text.lastIndexOf(GENERATED_MARKER, 200) !== -1) continue;

    // Nor is the trace export a call site. It names every tool the agent
    // called, by construction, so scanning it turns one file the user handed
    // us into a `tool_reference` per span — the lockfile mistake again, found
    // the same way, by running it. Its evidence belongs on the observed reach,
    // which says how many calls rather than which line of JSON.
    if (tracePath !== null && path === tracePath) continue;

    files += 1;
    bytes += text.length;

    for (const quote of quotes) {
      for (const line of quoteLines(text, quote)) {
        const rows = quoteFiles.get(quote) ?? [];
        rows.push({ path, line });
        quoteFiles.set(quote, rows);
      }
    }

    // A prose file is read for its quotes and for nothing else. A README that
    // names a tool is documentation, not a line that stops working, and the
    // other reaches are all claims about code.
    if (isProseFile(path)) continue;

    SPECIFIER.lastIndex = 0;
    for (let m = SPECIFIER.exec(text); m !== null; m = SPECIFIER.exec(text)) {
      const specifier = m[1];
      if (specifier === undefined) continue;
      const subpath = subpathOf(specifier, pkg);
      if (subpath === null) continue;
      if (!importedSubpaths.has(subpath)) {
        importedSubpaths.set(subpath, `${path}:${lineOf(text, m.index)}`);
      }
    }

    for (const tool of toolNames) {
      for (const line of wordLines(text, tool)) {
        const rows = toolFiles.get(tool) ?? [];
        rows.push({ path, line });
        toolFiles.set(tool, rows);
      }
    }

    for (const alias of aliasNames) {
      for (const line of aliasLines(text, alias)) {
        const rows = aliasFiles.get(alias) ?? [];
        rows.push({ path, line });
        aliasFiles.set(alias, rows);
      }
    }
  }

  // --- per finding ----------------------------------------------------------

  for (const target of targets) {
    // A door the repo never opens cannot reach it, however true the finding is.
    // Only applied to subpath-shaped surfaces: a `bin:` surface is a command, and
    // a manifest filename is not something a repo imports at all, so neither can
    // be ruled out by looking at import specifiers.
    const isSubpath = target.surface === "." || target.surface.startsWith("./");
    if (isSubpath && importedSubpaths.size > 0 && !importedSubpaths.has(target.surface)) {
      filtered.push({
        target: target.label,
        kind: "subpath_not_imported",
        reason: `the repo does not import ${pkg}${target.surface === "." ? "" : target.surface.slice(1)}`,
      });
      continue;
    }

    const importedAt = isSubpath ? importedSubpaths.get(target.surface) : undefined;
    if (importedAt !== undefined) {
      reaches.push({
        kind: "surface_import",
        target: target.surface,
        evidence: importedAt,
        // Names the door, not the finding. A detail that named the finding
        // would make two findings on one import look like two places to look.
        detail: `imports the door this finding is on`,
      });
    }

    // Proof, not inference. Reported before anything the scan inferred, and
    // reported even when a source file names the tool as well: "you call this"
    // and "you mention this" are different claims and the first one is the one
    // a person acts on.
    const calls = usage === undefined ? 0 : callsOf(usage, target.tool);
    if (calls > 0) {
      reaches.push({
        kind: "observed_call",
        target: target.tool,
        evidence: usage?.source ?? "traces",
        detail: `called ${calls} time(s) in the traces supplied`,
      });
    }

    const hits = toolFiles.get(target.tool) ?? [];

    // No line of source names this tool, and yet the repo opens the door it is
    // declared on. That is the ordinary case for a contract a model consumes:
    // the code hands the pack over and the model chooses. Saying nothing here
    // would let the strongest version of the finding present as no reach at
    // all, so the mount site is reported as the reach it is.
    //
    // Anchored to a mount, never to the manifest. A dependency on its own
    // already has its own reach, and stretching this kind to cover it would
    // turn "we found no imports" into a positive claim about how the package
    // is used.
    if (hits.length === 0 && calls === 0 && importedAt !== undefined) {
      reaches.push({
        kind: "model_consumer",
        target: target.tool,
        evidence: importedAt,
        detail: `mounts the contract \`${target.tool}\` is in; no file names the tool, so the caller is the model`,
      });
    }

    for (const hit of hits) {
      reaches.push({
        kind: "tool_reference",
        target: target.tool,
        evidence: `${hit.path}:${hit.line}`,
        detail: `names \`${target.tool}\``,
      });
    }

    // The consumer's own name for this operation. Reported before the prose
    // match only in file order; both are their code naming the thing.
    for (const alias of target.aliases ?? []) {
      // An exact path identifies one operation. A resource name identifies the
      // family it belongs to, and saying so is the difference between a claim
      // somebody can act on and one they have to work out.
      const exact = alias.startsWith("/") || /^[A-Z]+ \//.test(alias);
      for (const hit of aliasFiles.get(alias) ?? []) {
        reaches.push({
          kind: "endpoint_reference",
          target: target.label,
          evidence: `${hit.path}:${hit.line}`,
          detail: exact
            ? `names \`${alias}\``
            : `uses the \`${alias.replace(/^\./, "")}\` resource this operation belongs to`,
        });
      }
    }

    // Word for word, and the strongest thing this layer can say about prose.
    // Reported wherever it is found, including in a file that imports nothing
    // and names no tool: a prompt is exactly that file, and it is the one the
    // stale sentence is most likely to be sitting in.
    for (const quote of target.quotes ?? []) {
      if (!isQuotable(quote)) continue;
      for (const hit of quoteFiles.get(normalise(quote).trim()) ?? []) {
        reaches.push({
          kind: "stale_quote",
          target: target.label,
          evidence: `${hit.path}:${hit.line}`,
          detail: `quotes a sentence the newer version deleted: "${truncateQuote(quote)}"`,
        });
      }
    }

    // Parameters are ordinary words. A match only counts inside a file that is
    // demonstrably about the tool, which is the difference between a useful
    // pointer and every file in the repo.
    if (target.param !== undefined) {
      const paths = [...new Set(hits.map((h) => h.path))];
      for (const path of paths) {
        const text = repo.read(path);
        if (text === null) continue;
        for (const line of wordLines(text, target.param)) {
          reaches.push({
            kind: "param_reference",
            target: `${target.tool}.${target.param}`,
            evidence: `${path}:${line}`,
            detail: `names \`${target.param}\` in a file that uses \`${target.tool}\``,
          });
        }
      }
    }
  }

  reaches.sort(compareReaches);

  // Two findings on one tool reach a consumer at the same line, and printing
  // that line twice says nothing the first line did not. The detail is part of
  // the key so a reach that really does carry different information survives.
  const seen = new Set<string>();
  const unique = reaches.filter((r) => {
    const key = `${r.kind}\u0000${r.target}\u0000${r.evidence}\u0000${r.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { reaches: unique, filtered, notes, scanned: { files, bytes } };
}
