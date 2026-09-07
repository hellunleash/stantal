import { extractFromManifest } from "../extract/manifest.js";
import { isPresent } from "../contract/surface.js";
import type { RepoSource } from "../blast/repo.js";

/**
 * Contracts a repository *writes*, as opposed to ones it installs.
 *
 * Every other entry point starts from a dependency. The audit's own output on a
 * real application is the argument for this one: **1 of 35 dependencies in
 * scope**, in a repo running five model-facing systems. Nearly all of its
 * model-facing contract was written in the repo — a host generating schemas
 * from its own routes and handing them to an agent — and none of it has a
 * version, a registry, or a semver range. Nothing upstream of this file could
 * see any of it.
 *
 * The reader already existed: `extractFromManifest` parses a host-generated
 * tool list as-is, and has been run against a real one. What was missing is
 * finding the file, and having something to compare it against.
 *
 * **Vendor-neutral by construction.** No path is hardcoded and no `format` key
 * is checked. A file counts as a contract when our own extractor reads tools
 * out of it, which is the same test the `manifest` command applies, so the set
 * of things discoverable here is exactly the set of things comparable there.
 */

/**
 * A contract this repo produces, and the documents that make it up.
 *
 * `sources` is ordered: the catalog defines the tool set, later documents only
 * refine it. That order is load-bearing rather than cosmetic — reading the
 * obvious file alone over-reported prose findings 2x and missed 7 removed tools
 * on a real host, because its descriptions are route strings and the prose a
 * model actually receives lives in the second file.
 */
export type HostContract = {
  /** Repo-relative path of the catalog: the document that defines the tool set. */
  catalog: string;
  /** Every document, catalog first, in merge order. */
  sources: string[];
  /** Tools in the merged contract. */
  tools: number;
  /** Tools carrying at least one parameter. Separates a skeleton from a schema. */
  withParams: number;
  /** Why these documents were grouped, in a sentence a person can check. */
  why: string;
};

export type DiscoveryNote = {
  where: string;
  detail: string;
};

export type Discovery = {
  contracts: HostContract[];
  /**
   * Files we could not read or parse. A gap, never a finding: a repo whose
   * contract we failed to open must not present as a repo that authors none.
   */
  notes: DiscoveryNote[];
  scanned: number;
};

/** Ours. Reading our own baseline back as a discovered contract would double every one. */
export const BASELINE_DIR = ".stantal/contracts";

/**
 * Everything this tool keeps in a repository: baselines, cassettes, seed
 * corpora, and on older installs an unpacked copy of every dependency.
 *
 * Skipped whole. Found by running this on its own repository, where the cache
 * held `notion-mcp-server`'s OpenAPI spec and it was reported as a contract
 * this project writes. It is somebody else's package, in our directory: the
 * lockfile mistake in a new costume.
 */
const OURS = ".stantal/";

/**
 * Files that read as a tool manifest but are not one.
 *
 * `package.json` is the loudest: it has a `name`, it can carry almost any key,
 * and it sits in every repo. Matched by basename, since a monorepo has many.
 */
const NEVER = new Set(["package.json", "tsconfig.json", "jsconfig.json", "composer.json"]);

function isCandidate(path: string): boolean {
  if (!path.endsWith(".json")) return false;
  if (path === OURS.slice(0, -1) || path.startsWith(OURS)) return false;
  return !NEVER.has(path.split("/").pop() ?? path);
}

/** Keys a serialized tool list has at least one of. Any of them earns a parse. */
const LOOKS_LIKE_A_CONTRACT = /"(tools|name|description|inputSchema|input_schema|parameters)"\s*:/;

export type DiscoveryOptions = {
  /**
   * Where a descriptor's fields live, when a producer nests them.
   *
   * Passed straight through to the extractor, and named by the caller for the
   * same reason it is named there: sniffing for the wrapper key would silently
   * read the wrong object the first time a producer chose a different name.
   *
   * It matters more here than anywhere else. On a real host the prose half of
   * the contract nests everything under `fields`, so without this the document
   * reads as no contract at all and the skeleton is watched alone — which is
   * precisely the mistake this feature exists to prevent.
   */
  fieldsKey?: string | undefined;
};

/** What one document declares, or null when it is not a contract at all. */
function readDocument(
  repo: RepoSource,
  path: string,
  fieldsKey: string | undefined,
): { tools: string[]; withParams: number; described: number } | null {
  const text = repo.read(path);
  if (text === null) return null;

  // Cheap gate before the parse. Most JSON in a repo is a config file, and
  // parsing every one of them is the whole cost of this walk.
  //
  // `name` alone is not enough: a document keyed by tool name carries the
  // identity in the key and needs no `name` field at all. That is the shape of
  // the annotation half of a split contract, so gating on `name` would drop
  // exactly the document this feature exists to find.
  if (!LOOKS_LIKE_A_CONTRACT.test(text)) return null;

  const result = extractFromManifest({
    text,
    package: path,
    version: "discovery",
    origin: path,
    ...(fieldsKey === undefined ? {} : { fieldsKey }),
  });
  if (!isPresent(result)) return null;

  const tools = result.contract.tools;
  if (tools.length === 0) return null;

  // A list of things with names is not a list of tools. `[{ "name": "Lisbon",
  // "population": 545796 }]` reads as descriptors and is a data file, and a
  // repo is full of those. Found by writing the test rather than by reasoning:
  // the first version of this reported a cities fixture as a contract.
  //
  // Stricter here than in `stantal manifest` on purpose. There a person points
  // at a file and says it is a contract; here we decide unprompted, so the
  // document has to carry something only a contract carries — prose written
  // for a caller, or a parameter schema.
  const described = tools.filter((t) => (t.description ?? "").length > 0).length;
  const withParams = tools.filter((t) => t.params.length > 0).length;
  if (described === 0 && withParams === 0) return null;

  return { tools: tools.map((t) => t.name), withParams, described };
}

/**
 * The tool names a document is keyed by, when we could not read it as a
 * contract.
 *
 * Used only to say something useful about a file we declined. A document that
 * names the same fifty tools as the contract next to it is almost certainly the
 * other half of it, and staying silent about that is how a snapshot ends up
 * watching the skeleton alone.
 */
function nameHints(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const root = parsed as Record<string, unknown> | null;
  const tools = root === null || typeof root !== "object" ? undefined : root["tools"];
  if (tools !== undefined && typeof tools === "object" && tools !== null && !Array.isArray(tools)) {
    return Object.keys(tools);
  }
  const list = Array.isArray(tools) ? tools : Array.isArray(parsed) ? parsed : [];
  return list
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["name"] : null))
    .filter((name): name is string => typeof name === "string");
}

/** The catalog's tool names, from the rows the walk collected. */
function namesOf(
  found: Map<string, { path: string; tools: string[] }[]>,
  catalog: string,
): string[] {
  for (const rows of found.values()) {
    const row = rows.find((r) => r.path === catalog);
    if (row !== undefined) return row.tools;
  }
  return [];
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "." : path.slice(0, at);
}

/**
 * How much of `other` the catalog already declares.
 *
 * A refinement annotates tools the host serves; it cannot introduce one. So the
 * test for "these two documents describe the same contract" is that the second
 * one's names are largely already in the first.
 */
function overlap(catalog: readonly string[], other: readonly string[]): number {
  if (other.length === 0) return 0;
  const known = new Set(catalog);
  return other.filter((name) => known.has(name)).length / other.length;
}

/** Most of it, not all of it: a document may name a tool the catalog has since dropped. */
const REFINES_AT = 0.8;

/**
 * Find the contracts a repository generates.
 *
 * Reads only, and stays offline. Nothing is executed and nothing is written —
 * saving a baseline is a separate step the user asks for, for the same reason
 * the no-argument audit reads and ranks but never writes.
 */
export function discoverHostContracts(repo: RepoSource, options: DiscoveryOptions = {}): Discovery {
  const notes: DiscoveryNote[] = [];
  const found = new Map<string, { path: string; tools: string[]; withParams: number; described: number }[]>();
  // Documents that name tools and that we could not read as contracts. Kept so
  // one sitting beside a contract can be pointed at rather than dropped.
  const declined = new Map<string, { path: string; names: string[] }[]>();
  let scanned = 0;

  for (const path of repo.files()) {
    if (!isCandidate(path)) continue;
    scanned += 1;

    let doc: ReturnType<typeof readDocument>;
    try {
      doc = readDocument(repo, path, options.fieldsKey);
    } catch (error) {
      // An unreadable candidate is a gap. It is not evidence of anything, and
      // it must not be silently dropped: a repo whose contract we failed to
      // open would otherwise look like a repo that authors none.
      notes.push({ where: path, detail: `could not be read: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const dir = directoryOf(path);
    if (doc === null) {
      const names = nameHints(repo.read(path) ?? "");
      if (names.length >= 2) {
        const rows = declined.get(dir) ?? [];
        rows.push({ path, names });
        declined.set(dir, rows);
      }
      continue;
    }

    const rows = found.get(dir) ?? [];
    rows.push({ path, ...doc });
    found.set(dir, rows);
  }

  const contracts: HostContract[] = [];

  for (const [dir, rows] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // The catalog is the document carrying schemas. When a host splits its
    // contract, the generated half has the parameters and the editable half has
    // the prose, and only the generated half can define the tool set.
    const ranked = [...rows].sort(
      (a, b) => b.withParams - a.withParams || b.tools.length - a.tools.length || a.path.localeCompare(b.path),
    );
    const catalog = ranked[0];
    if (catalog === undefined) continue;

    // A refinement carries no schemas. The split this handles is a generated
    // half that has the parameters and an editable half that has the prose, so
    // a second document with schemas of its own is not an annotation layer — it
    // is another contract, or an older copy of this one.
    //
    // Found by running this here, on a directory holding two snapshots of the
    // same host taken weeks apart. Merged, the older copy's descriptions would
    // be read as the current contract's prose: a false statement about what a
    // model is being handed today, produced by our own convenience.
    const refinements = ranked
      .slice(1)
      .filter((r) => r.withParams === 0 && overlap(catalog.tools, r.tools) >= REFINES_AT);

    // A document in the same directory that names a different tool set is a
    // different contract, not a refinement of this one. Grouping them would
    // merge two hosts into one and report every tool of each as missing from
    // the other.
    for (const stray of ranked.slice(1)) {
      if (refinements.includes(stray)) continue;
      contracts.push({
        catalog: stray.path,
        sources: [stray.path],
        tools: stray.tools.length,
        withParams: stray.withParams,
        why: "reads as a tool manifest on its own",
      });
    }

    contracts.push({
      catalog: catalog.path,
      sources: [catalog.path, ...refinements.map((r) => r.path)],
      tools: catalog.tools.length,
      withParams: catalog.withParams,
      why:
        refinements.length === 0
          ? "reads as a tool manifest on its own"
          : `${refinements.length} document(s) in ${dir} name the same tools and are merged after it`,
    });
  }

  // A document that names the same tools as a contract beside it is almost
  // certainly the other half of it: the generated half carries the schemas and
  // the editable half the prose. If we could not read it, the snapshot is
  // watching the skeleton alone, which is the exact mistake this exists to
  // prevent — so it is said out loud, with the flag that fixes it.
  for (const contract of contracts) {
    for (const row of declined.get(directoryOf(contract.catalog)) ?? []) {
      if (overlap(contract.sources.includes(row.path) ? [] : namesOf(found, contract.catalog), row.names) < REFINES_AT) {
        continue;
      }
      notes.push({
        where: row.path,
        detail:
          `names ${row.names.length} of the same tools as ${contract.catalog} but no descriptors could be read from it. ` +
          `If its fields are nested under a wrapper, pass --fields-at <key> so both halves are read.`,
      });
    }
  }

  contracts.sort((a, b) => a.catalog.localeCompare(b.catalog));
  return { contracts, notes, scanned };
}

/**
 * Directory a contract's baseline is stored under.
 *
 * Derived from the catalog path so one repo can hold several, and so the name
 * says which file it snapshots. Slugged rather than nested: a stored copy that
 * mirrored the original layout would be indistinguishable from the original on
 * the next walk.
 */
export function baselineSlug(catalog: string): string {
  const slug = catalog
    .replace(/\.json$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug.length === 0 ? "contract" : slug;
}
