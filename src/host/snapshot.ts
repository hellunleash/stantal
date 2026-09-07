import { buildManifestReport } from "../report.js";
import type { Report } from "../report.js";
import type { Judge } from "../prose/judge.js";
import type { RepoSource } from "../blast/repo.js";
import { discoverHostContracts, type Discovery, type HostContract } from "./discover.js";
import { baselinePath, loadBaseline, readBaselineMeta, saveBaseline } from "./baseline.js";

/**
 * Contracts this repo writes: find them, and say what changed since last time.
 *
 * The pair here is not two releases. It is **the same file, twice**: the
 * baseline that was saved and the document on disk now. Everything downstream
 * is unchanged — the same extractor, the same four layers, the same verdict —
 * because a contract does not care whether its two sides came from a registry
 * or from one directory a week apart.
 */

export type SnapshotEntry = {
  contract: HostContract;
  /** Where the baseline is stored, or null when this contract has never been saved. */
  baseline: string | null;
  /** The comparison, or null when there was nothing to compare against. */
  report: Report | null;
  /** Why there is no report. Never null at the same time as `report`. */
  note: string | null;
};

export type SnapshotResult = {
  discovery: Discovery;
  entries: SnapshotEntry[];
};

export type SnapshotOptions = {
  root: string;
  repo: RepoSource;
  judge?: Judge | null;
  /** Passed through to the extractor, exactly as `stantal manifest` takes them. */
  fieldsKey?: string | undefined;
  excludeWhen?: readonly { key: string; value: string }[] | undefined;
};

/**
 * Compare every discovered contract against its baseline.
 *
 * Reads and reports. Saving is `saveSnapshots`, a separate call the user has to
 * ask for, for the same reason the no-argument audit never writes: a command
 * that edits a repository the first time it is run is one people stop running.
 */
export async function snapshotHostContracts(options: SnapshotOptions): Promise<SnapshotResult> {
  const discovery = discoverHostContracts(options.repo, { fieldsKey: options.fieldsKey });
  const entries: SnapshotEntry[] = [];

  for (const found of discovery.contracts) {
    const contract = alignToBaseline(options.root, found);
    const stored = loadBaselineSafely(options.root, contract);
    if (stored.error !== null) {
      entries.push({ contract, baseline: baselinePath(contract.catalog), report: null, note: stored.error });
      continue;
    }
    if (stored.value === null) {
      entries.push({
        contract,
        baseline: null,
        report: null,
        note: "no baseline saved yet, so there is nothing to compare against",
      });
      continue;
    }

    const now: { text: string; origin: string }[] = [];
    let missing: string | null = null;
    for (const path of contract.sources) {
      const text = options.repo.read(path);
      if (text === null) {
        missing = `${path} could not be read`;
        break;
      }
      now.push({ text, origin: path });
    }
    if (missing !== null) {
      entries.push({ contract, baseline: baselinePath(contract.catalog), report: null, note: missing });
      continue;
    }

    const report = await buildManifestReport({
      // Versions a person can tell apart at a glance. A generated contract has
      // no version of its own, and inventing a number would put a version in
      // the report that exists nowhere else and cannot be checked.
      from: { version: `baseline ${stored.value.meta.savedAt.slice(0, 10)}`, sources: stored.value.sources },
      to: { version: "working tree", sources: now },
      package: contract.catalog,
      ...(options.judge ? { judge: options.judge } : {}),
      ...(options.fieldsKey !== undefined ? { fieldsKey: options.fieldsKey } : {}),
      ...(options.excludeWhen !== undefined ? { excludeWhen: options.excludeWhen } : {}),
      // Layer 3 is deliberately not run here. Its first question is whether the
      // manifest declares the package and whether the declared range admits an
      // affected version, and a contract this repo generates has no package
      // name, no range and no version. Handed one, the scan answers "not a
      // declared dependency" for every finding — the strongest possible
      // "nothing reaches you", about a file sitting in the repo.
    });

    entries.push({ contract, baseline: baselinePath(contract.catalog), report, note: null });
  }

  return { discovery, entries };
}

/**
 * A watched contract keeps the identity its baseline gave it.
 *
 * Discovery picks the catalog by which document carries the schemas, and that
 * choice is unstable in exactly the case this feature exists for: when a
 * regeneration ships 50 tools with 2 schemas, the file that had the parameters
 * no longer does, the two documents tie, and the tie breaks on the filename.
 * The contract would then be looked up under a name nothing was ever saved
 * under, and the answer would be "no baseline yet" on the one run that had
 * something to say.
 *
 * So the baseline is authoritative about which document is the catalog and in
 * what order the rest merge. Found once, recorded, and not re-decided every
 * run — a heuristic is a fine way to notice a contract and a poor way to keep
 * track of one.
 */
export function alignToBaseline(root: string, contract: HostContract): HostContract {
  for (const path of contract.sources) {
    const meta = readBaselineMeta(root, path);
    if (meta === null || meta.catalog !== path) continue;
    if (meta.catalog === contract.catalog) return contract;

    const order = meta.sources.map((s) => s.path).filter((p) => contract.sources.includes(p));
    // A document added since the baseline was saved still belongs to the
    // contract. It goes last, where a refinement goes.
    const added = contract.sources.filter((p) => !order.includes(p));
    return { ...contract, catalog: path, sources: [...order, ...added] };
  }
  return contract;
}

function loadBaselineSafely(
  root: string,
  contract: HostContract,
): { value: ReturnType<typeof loadBaseline>; error: string | null } {
  try {
    return { value: loadBaseline(root, contract.catalog), error: null };
  } catch (error) {
    // A baseline whose documents are half missing is broken, not empty.
    // Comparing against the half that survived would report every tool of the
    // missing document as removed.
    return { value: null, error: `baseline is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Write the baseline for every discovered contract. The step that writes. */
export function saveSnapshots(
  root: string,
  repo: RepoSource,
  contracts: readonly HostContract[],
): Array<{ contract: HostContract; path: string | null; error: string | null }> {
  return contracts.map((found) => {
    // Aligned before writing, like the comparison is. Otherwise a regeneration
    // that moved the schemas would file a second baseline under a new name and
    // orphan the one that was being watched.
    const contract = alignToBaseline(root, found);
    try {
      const written = saveBaseline(root, contract, (path) => repo.read(path));
      return { contract, path: written.path, error: null };
    } catch (error) {
      return { contract, path: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
