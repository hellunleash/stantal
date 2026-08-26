import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Contract } from "../contract/types.js";
import { present, type CallRequest, type ToolCaller, type ToolChoice } from "./caller.js";
import { compareRuns, type ComparisonResult, type IntentRuns } from "./compare.js";
import { changedTools, modeForBump, selectIntents, type Intent, type SelectionMode } from "./intent.js";
import { MIN_RUNS } from "./taxonomy.js";

/**
 * Running a corpus of intents against two contracts.
 *
 * Three cost levers, in the order they matter, all of them from
 * `docs/how-to-move-fast.md`:
 *
 * 1. **Record once, replay forever.** Every call is a cassette on disk, keyed on
 *    what was actually sent. This is the same lever as the judge cache and for
 *    the same reason: the thing that costs money is also the thing that
 *    disagrees with itself between runs.
 * 2. **Affected-intent selection.** A version pair replays only the intents
 *    whose slice changed — except on a breaking bump, where it replays
 *    everything, because a change in one tool can move which tool gets picked.
 * 3. **The contract is the key, not the version.** Two versions whose contract
 *    is byte-identical on a surface share every cassette. Over a release history
 *    most consecutive pairs are exactly that.
 */

export type RunOptions = {
  from: { version: string; contract: Contract };
  to: { version: string; contract: Contract };
  intents: readonly Intent[];
  caller: ToolCaller;
  /** Runs per intent per side. See `MIN_RUNS` for why the default is what it is. */
  k?: number;
  /** Override the bump-derived choice. Mostly for tests. */
  mode?: SelectionMode;
  cache?: BehaviourCache;
  /**
   * How many calls may be in flight at once. See `DEFAULT_CONCURRENCY`.
   *
   * 1 restores the original strictly-serial order, which is what a test that
   * asserts on call sequence wants.
   */
  concurrency?: number;
};

export type RunResult = ComparisonResult & {
  caller: string;
  k: number;
  mode: SelectionMode;
  /** Intents actually replayed, out of the corpus. */
  replayed: number;
  corpus: number;
  stats: CacheStats;
};

// --- the cassette -----------------------------------------------------------

export type CacheMode = "record" | "replay" | "off";
export type CacheStats = { hits: number; misses: number; writes: number };

export type BehaviourCache = {
  mode: CacheMode;
  dir: string;
};

export const DEFAULT_BEHAVIOUR_CACHE_DIR = ".stantal/behaviour";

type Cassette = {
  version: 1;
  caller: string;
  /** What was sent, stored so a changed contract cannot serve an old answer. */
  request: CallRequest;
  run: number;
  choice: ToolChoice;
  recordedAt: string;
};

/**
 * The identity of one call.
 *
 * Includes the run index, so k samples stay k distinct cassettes rather than
 * one answer replayed k times — replaying one answer k times would collapse
 * every interval to zero width and make everything look certain.
 */
function callHash(callerId: string, request: CallRequest, run: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, caller: callerId, request, run }))
    .digest("hex");
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function cassettePath(dir: string, callerId: string, hash: string): string {
  return join(dir, slug(callerId), `${hash.slice(0, 32)}.json`);
}

function readCassette(path: string): Cassette | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Cassette;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCassette(path: string, cassette: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
}

// --- running ----------------------------------------------------------------

async function runOnce(
  caller: ToolCaller,
  request: CallRequest,
  run: number,
  cache: BehaviourCache | undefined,
  stats: CacheStats,
): Promise<ToolChoice | null> {
  if (cache === undefined || cache.mode === "off") return caller.call(request);

  const hash = callHash(caller.id, request, run);
  const path = cassettePath(cache.dir, caller.id, hash);
  const found = readCassette(path);

  // The stored request is compared, not trusted. A contract that changed by one
  // character must not be served an answer recorded against the old one.
  if (found !== null && JSON.stringify(found.request) === JSON.stringify(request)) {
    stats.hits += 1;
    return found.choice;
  }

  stats.misses += 1;
  // A miss in replay mode is left unanswered on purpose: the run is short by
  // one sample, the interval widens, and nothing is claimed that was not
  // measured. It cannot call out, so it cannot spend.
  if (cache.mode === "replay") return null;

  const choice = await caller.call(request);
  writeCassette(path, {
    version: 1,
    caller: caller.id,
    request,
    run,
    choice,
    recordedAt: new Date().toISOString(),
  });
  stats.writes += 1;
  return choice;
}

/**
 * How many calls are allowed in flight at once.
 *
 * This layer's cost is `k` calls per intent per side, and every one of them was
 * awaited in turn. A 55-intent corpus at k=3 is 330 calls, which at a few
 * seconds each is most of an hour — long enough that nobody waits for the
 * answer, which makes the layer useless whatever it finds.
 *
 * They are independent by construction. A cassette is keyed on the caller, the
 * request and the run index, none of which depend on what any other call did,
 * and no call reads another's result. So the serial order was never carrying
 * anything — it was just the shape the loop happened to have.
 *
 * 8 rather than unbounded: providers rate-limit, and a corpus fired all at once
 * turns a slow run into a failed one.
 */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Run tasks with a bounded number in flight, results in the order given.
 *
 * Indexed rather than pushed on completion, so the output does not depend on
 * which call happened to return first. That matters beyond tidiness: these
 * become the samples a Wilson interval is computed over, and a comparison whose
 * input order shifted between runs would not be reproducible.
 */
async function pooled<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length) as T[];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      out[index] = await tasks[index]!();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return out;
}

/**
 * The request for one intent against one contract.
 *
 * Pure, so both sides can be built up front and the whole run scheduled as one
 * pool instead of two sequential halves.
 */
function requestFor(tools: ReturnType<typeof present>, intent: Intent): CallRequest {
  // The key is spread in only when there is history to carry. Setting it to
  // `[]` would change the serialized request for every single-turn intent
  // and invalidate every cassette recorded before history existed.
  return {
    intent: intent.text,
    tools,
    ...(intent.history !== undefined && intent.history.length > 0
      ? { history: intent.history }
      : {}),
  };
}

async function runSide(
  contract: Contract,
  intents: readonly Intent[],
  caller: ToolCaller,
  k: number,
  cache: BehaviourCache | undefined,
  stats: CacheStats,
  concurrency: number,
): Promise<IntentRuns[]> {
  const tools = present(contract);
  const requests = intents.map((intent) => requestFor(tools, intent));

  // One flat task list across every intent and every run, so the pool stays
  // saturated. Scheduling per intent would idle the pool at each boundary
  // waiting for that intent's slowest call.
  const tasks: Array<() => Promise<ToolChoice | null>> = [];
  for (const request of requests) {
    for (let run = 0; run < k; run += 1) {
      tasks.push(() => runOnce(caller, request, run, cache, stats));
    }
  }

  const results = await pooled(tasks, concurrency);

  return intents.map((intent, i) => ({
    intent,
    // A null is a replay miss: the run is short one sample, the interval
    // widens, and nothing is claimed that was not measured.
    choices: results.slice(i * k, i * k + k).filter((c): c is ToolChoice => c !== null),
  }));
}

export async function runBehaviour(options: RunOptions): Promise<RunResult> {
  const k = options.k ?? MIN_RUNS;
  const mode = options.mode ?? modeForBump(options.from.version, options.to.version);

  const changed = changedTools(options.from.contract, options.to.contract);
  const selected = selectIntents(options.intents, changed, mode);

  const stats: CacheStats = { hits: 0, misses: 0, writes: 0 };
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  // The sides stay ordered. Each already saturates the pool on its own, so
  // interleaving them would not raise throughput — total calls and the
  // in-flight ceiling are what set the wall time — and it would double the load
  // a provider sees from one run.
  const before = await runSide(options.from.contract, selected, options.caller, k, options.cache, stats, concurrency);
  const after = await runSide(options.to.contract, selected, options.caller, k, options.cache, stats, concurrency);

  const comparison = compareRuns({
    before: { contract: options.from.contract, runs: before },
    after: { contract: options.to.contract, runs: after },
  });

  return {
    ...comparison,
    caller: options.caller.id,
    k,
    mode,
    replayed: selected.length,
    corpus: options.intents.length,
    stats,
  };
}

/** Cache settings from the environment, matching the judge's vocabulary. */
export function behaviourCacheFromEnv(env: NodeJS.ProcessEnv = process.env): BehaviourCache {
  const raw = env["STANTAL_BEHAVIOUR_CACHE"]?.toLowerCase();
  const mode: CacheMode = raw === "replay" || raw === "off" || raw === "record" ? raw : "record";
  return { mode, dir: env["STANTAL_BEHAVIOUR_CACHE_DIR"] ?? DEFAULT_BEHAVIOUR_CACHE_DIR };
}
