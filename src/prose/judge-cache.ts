import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  JUDGE_SYSTEM_PROMPT,
  renderQuestion,
  type Judge,
  type JudgeAnswer,
  type JudgeQuestion,
} from "./judge.js";

/**
 * Record once, replay forever.
 *
 * The judge is the only part of this system that costs money and the only part
 * that answers differently on two identical runs. Both problems have the same
 * fix, and it is the one the fast-loop discipline already prescribes: the first
 * time a question is answered, capture it as a fixture; never ask it live twice.
 *
 * Two things fall out of that, and both matter more than the saving:
 *
 * 1. **Runs become reproducible.** A recorded answer replays byte-identically,
 *    so a report can be regenerated without hoping the model agrees with itself.
 * 2. **The gate stays free.** In `replay` mode a cache miss returns unclear
 *    instead of reaching for the network, so no test can ever spend a token by
 *    accident — not even a new one written by someone who forgot.
 *
 * The cache is keyed on the *text of the question*, never on its id. That is
 * what makes it worth having: a walk over 33 releases asks about an unchanged
 * parameter 33 times, and those are one question, not thirty-three. Ids are
 * per-candidate and would defeat the whole thing.
 */

export type JudgeCacheMode =
  /** Serve from disk, call for misses, write what comes back. */
  | "record"
  /** Serve from disk. A miss is unclear. Never calls out, so it cannot spend. */
  | "replay"
  /** No cache at all. */
  | "off";

export type JudgeCacheOptions = {
  dir: string;
  mode?: JudgeCacheMode;
  /** Reported so a caller can print what a run actually cost. */
  onEvent?: (event: JudgeCacheEvent) => void;
};

export type JudgeCacheEvent =
  | { type: "hit"; id: string }
  | { type: "miss"; id: string }
  | { type: "stale"; id: string }
  | { type: "write"; id: string };

export type JudgeCacheStats = { hits: number; misses: number; stale: number; writes: number };

/** What a cassette holds. The question is stored so prompt drift invalidates it. */
type Cassette = {
  version: 1;
  judge: string;
  kind: JudgeQuestion["kind"];
  /** The exact prompt this answer was given. Compared on read, not trusted. */
  question: string;
  answer: { verdict: JudgeAnswer["verdict"]; quote: string | null };
  recordedAt: string;
};

/**
 * The identity of a question, for cache purposes.
 *
 * Includes the system prompt and the judge id. Changing either changes what the
 * answer means, so a cassette recorded under the old wording must not be served
 * under the new one — it would be a stale answer wearing a fresh label.
 */
export function questionHash(judgeId: string, question: JudgeQuestion): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        judge: judgeId,
        system: JUDGE_SYSTEM_PROMPT,
        kind: question.kind,
        prompt: renderQuestion(question),
      }),
    )
    .digest("hex");
}

/** Judge ids carry a colon, which is not a legal path segment on Windows. */
function slug(judgeId: string): string {
  return judgeId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function cassettePath(dir: string, judgeId: string, hash: string): string {
  return join(dir, slug(judgeId), `${hash.slice(0, 32)}.json`);
}

function readCassette(path: string): Cassette | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Cassette;
    return parsed.version === 1 ? parsed : null;
  } catch {
    // Absent, unreadable, or corrupt all mean the same thing here: ask again.
    return null;
  }
}

function writeCassette(path: string, cassette: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
}

/**
 * Wrap a judge so identical questions are asked once, ever.
 *
 * The wrapper keeps the inner judge's id. A cassette is a transport detail, not
 * a different reader, and a report that claimed to be judged by "cache" would be
 * lying about where the answer came from.
 */
export function cachingJudge(inner: Judge, options: JudgeCacheOptions): Judge & {
  stats(): JudgeCacheStats;
} {
  const mode = options.mode ?? "record";
  const stats: JudgeCacheStats = { hits: 0, misses: 0, stale: 0, writes: 0 };
  const emit = options.onEvent ?? (() => {});

  return {
    id: inner.id,
    stats: () => ({ ...stats }),

    async ask(questions) {
      if (questions.length === 0) return [];
      if (mode === "off") return inner.ask(questions);

      const answers: JudgeAnswer[] = [];
      const misses: JudgeQuestion[] = [];
      const hashes = new Map<string, string>();

      for (const question of questions) {
        const hash = questionHash(inner.id, question);
        hashes.set(question.id, hash);

        const cassette = readCassette(cassettePath(options.dir, inner.id, hash));
        // The hash already covers the prompt, so a mismatch here means a
        // collision or a hand-edited file. Either way, do not serve it.
        const usable = cassette !== null && cassette.question === renderQuestion(question);

        if (usable && cassette !== null) {
          stats.hits += 1;
          emit({ type: "hit", id: question.id });
          // The stored id belonged to whichever candidate recorded it. Serve the
          // caller's id, or `reconcile` drops the answer as unmatched.
          answers.push({ id: question.id, verdict: cassette.answer.verdict, quote: cassette.answer.quote });
          continue;
        }

        if (cassette !== null) {
          stats.stale += 1;
          emit({ type: "stale", id: question.id });
        } else {
          stats.misses += 1;
          emit({ type: "miss", id: question.id });
        }
        misses.push(question);
      }

      // A miss in replay mode is left unanswered on purpose. `reconcile` turns
      // that into unclear, which is the honest result: nobody read it.
      if (misses.length === 0 || mode === "replay") return answers;

      const fresh = await inner.ask(misses);
      const byId = new Map(fresh.map((a) => [a.id, a]));

      for (const question of misses) {
        const answer = byId.get(question.id);
        if (answer === undefined) continue;

        const hash = hashes.get(question.id);
        if (hash !== undefined) {
          writeCassette(cassettePath(options.dir, inner.id, hash), {
            version: 1,
            judge: inner.id,
            kind: question.kind,
            question: renderQuestion(question),
            answer: { verdict: answer.verdict, quote: answer.quote },
            recordedAt: new Date().toISOString(),
          });
          stats.writes += 1;
          emit({ type: "write", id: question.id });
        }

        answers.push(answer);
      }

      return answers;
    },
  };
}

export const DEFAULT_JUDGE_CACHE_DIR = ".stantal/judge";

/** Cache mode from the environment. Defaults to recording, which is safe. */
export function cacheModeFromEnv(env: NodeJS.ProcessEnv = process.env): JudgeCacheMode {
  const raw = env["STANTAL_JUDGE_CACHE"]?.toLowerCase();
  return raw === "replay" || raw === "off" || raw === "record" ? raw : "record";
}
