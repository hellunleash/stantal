import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheModeFromEnv, cachingJudge, questionHash } from "./judge-cache.js";
import { reconcile, type Judge, type JudgeQuestion } from "./judge.js";
import { judgeFromEnv } from "./judges.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stantal-judge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A judge that records what it was asked, so calls can be counted. */
function countingJudge(verdict: "yes" | "no" | "unclear" = "no", quote: string | null = null) {
  const calls: JudgeQuestion[][] = [];
  const judge: Judge = {
    id: "test:model-1",
    async ask(questions) {
      calls.push([...questions]);
      return questions.map((q) => ({ id: q.id, verdict, quote }));
    },
  };
  return { judge, calls, asked: () => calls.flat().length };
}

function documented(id: string, param: string, description: string): JudgeQuestion {
  return { id, kind: "is_parameter_documented", tool: "make", param, description };
}

function soleFile(folder: string): string {
  const [name] = readdirSync(folder);
  if (name === undefined) throw new Error(`nothing recorded in ${folder}`);
  return join(folder, name);
}

describe("questionHash", () => {
  it("is the same for the same question text under different ids", () => {
    // The point of the cache: a walk asks about an unchanged parameter once per
    // release, and those are one question.
    const a = documented("documented:make.app@0.9.0", "app", "Create a thing.");
    const b = documented("documented:make.app@0.24.0", "app", "Create a thing.");
    expect(questionHash("test:model-1", a)).toBe(questionHash("test:model-1", b));
  });

  it("differs when the description differs", () => {
    const a = documented("q", "app", "Create a thing.");
    const b = documented("q", "app", "Create a thing. Pass the app to edit.");
    expect(questionHash("test:model-1", a)).not.toBe(questionHash("test:model-1", b));
  });

  it("differs per judge, so one model answer is never served as another", () => {
    // The two ids here just need to be distinct judges — any two would prove
    // the point. Using the real defaults keeps the test honest as they move.
    const q = documented("q", "app", "Create a thing.");
    expect(questionHash("openai:gpt-5.4-mini", q)).not.toBe(questionHash("gemini:gemini-3.6-flash", q));
  });
});

describe("cachingJudge", () => {
  it("asks once and replays after that", async () => {
    const { judge, asked } = countingJudge();
    const cached = cachingJudge(judge, { dir });
    const q = documented("q1", "app", "Create a thing.");

    await cached.ask([q]);
    await cached.ask([q]);
    await cached.ask([q]);

    expect(asked()).toBe(1);
    expect(cached.stats()).toMatchObject({ hits: 2, misses: 1, writes: 1 });
  });

  it("collapses the same question arriving under many ids", async () => {
    const { judge, asked } = countingJudge();
    const cached = cachingJudge(judge, { dir });
    const text = "Create a thing.";

    for (const version of ["0.9.0", "0.10.0", "0.11.0", "0.12.0"]) {
      await cached.ask([documented(`documented:make.app@${version}`, "app", text)]);
    }

    // Four releases, one call. This is the whole saving.
    expect(asked()).toBe(1);
    expect(cached.stats().hits).toBe(3);
  });

  it("serves the id the caller asked with, not the id that was recorded", async () => {
    const { judge } = countingJudge("no");
    const cached = cachingJudge(judge, { dir });
    const text = "Create a thing.";

    await cached.ask([documented("first-id", "app", text)]);
    const [answer] = await cached.ask([documented("second-id", "app", text)]);

    // Serving the recorded id would make reconcile drop it as unmatched, and the
    // finding would silently fall back to unconfirmed.
    expect(answer?.id).toBe("second-id");
  });

  it("only sends the misses to the inner judge", async () => {
    const { judge, calls } = countingJudge();
    const cached = cachingJudge(judge, { dir });
    const known = documented("a", "app", "Create a thing.");
    const fresh = documented("b", "slot", "Somewhere else entirely.");

    await cached.ask([known]);
    await cached.ask([known, fresh]);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.map((q) => q.id)).toEqual(["b"]);
  });

  it("returns an answer for every question, hit or miss", async () => {
    const { judge } = countingJudge();
    const cached = cachingJudge(judge, { dir });
    const a = documented("a", "app", "Create a thing.");
    const b = documented("b", "slot", "Somewhere else.");

    await cached.ask([a]);
    const answers = await cached.ask([a, b]);
    expect(answers.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
});

describe("replay mode", () => {
  it("never calls out, even on a miss", async () => {
    const { judge, asked } = countingJudge();
    const cached = cachingJudge(judge, { dir, mode: "replay" });

    await cached.ask([documented("q1", "app", "Create a thing.")]);

    // The guarantee the offline gate rests on: a test cannot spend a token by
    // accident, not even a new one written by someone who forgot.
    expect(asked()).toBe(0);
  });

  it("leaves a miss unanswered, which reconcile reads as unclear", async () => {
    const { judge } = countingJudge();
    const cached = cachingJudge(judge, { dir, mode: "replay" });
    const q = documented("q1", "app", "Create a thing.");

    const answers = await cached.ask([q]);
    expect(answers).toEqual([]);
    expect(reconcile([q], answers).get("q1")?.verdict).toBe("unclear");
  });

  it("still serves what was recorded", async () => {
    const q = documented("q1", "app", "Create a thing. Pass the app to edit one.");
    const { judge } = countingJudge("yes", "Pass the app to edit one.");
    await cachingJudge(judge, { dir, mode: "record" }).ask([q]);

    const { judge: cold, asked } = countingJudge();
    const replaying = cachingJudge(cold, { dir, mode: "replay" });
    const [answer] = await replaying.ask([q]);

    expect(answer?.verdict).toBe("yes");
    expect(asked()).toBe(0);
  });
});

describe("off mode", () => {
  it("passes through and writes nothing", async () => {
    const { judge, asked } = countingJudge();
    const cached = cachingJudge(judge, { dir, mode: "off" });
    const q = documented("q1", "app", "Create a thing.");

    await cached.ask([q]);
    await cached.ask([q]);

    expect(asked()).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("a cassette that cannot be trusted", () => {
  it("is re-asked when the recorded prompt does not match", async () => {
    const q = documented("q1", "app", "Create a thing.");
    const { judge } = countingJudge("yes", "Create a thing.");
    await cachingJudge(judge, { dir, mode: "record" }).ask([q]);

    // A hand-edited or collided file: right hash, wrong prompt.
    const file = soleFile(join(dir, "test_model-1"));
    const cassette = JSON.parse(readFileSync(file, "utf8")) as { question: string };
    cassette.question = "a completely different question";
    writeFileSync(file, JSON.stringify(cassette));

    const { judge: second, asked } = countingJudge("no");
    const cached = cachingJudge(second, { dir, mode: "record" });
    await cached.ask([q]);

    expect(asked()).toBe(1);
    expect(cached.stats().stale).toBe(1);
  });

  it("is re-asked when the file is corrupt", async () => {
    const q = documented("q1", "app", "Create a thing.");
    const { judge } = countingJudge();
    await cachingJudge(judge, { dir, mode: "record" }).ask([q]);

    writeFileSync(soleFile(join(dir, "test_model-1")), "{ not json");

    const { judge: second, asked } = countingJudge();
    await cachingJudge(second, { dir, mode: "record" }).ask([q]);
    expect(asked()).toBe(1);
  });

  it("does not let a replayed answer skip the quote check", async () => {
    const q = documented("q1", "app", "Create a thing.");
    // A fabricated justification, recorded. It must still fail closed on replay.
    const { judge } = countingJudge("yes", "a sentence that was never in the description");
    await cachingJudge(judge, { dir, mode: "record" }).ask([q]);

    const { judge: cold } = countingJudge();
    const answers = await cachingJudge(cold, { dir, mode: "replay" }).ask([q]);

    expect(reconcile([q], answers).get("q1")?.verdict).toBe("unclear");
  });
});

describe("cacheModeFromEnv", () => {
  it("records by default", () => {
    expect(cacheModeFromEnv({})).toBe("record");
  });

  it("reads replay and off", () => {
    expect(cacheModeFromEnv({ STANTAL_JUDGE_CACHE: "replay" })).toBe("replay");
    expect(cacheModeFromEnv({ STANTAL_JUDGE_CACHE: "OFF" })).toBe("off");
  });

  it("ignores a value it does not understand", () => {
    expect(cacheModeFromEnv({ STANTAL_JUDGE_CACHE: "sometimes" })).toBe("record");
  });
});

describe("judgeFromEnv with the cache wired in", () => {
  it("keeps the inner judge id, so a report names the model and not the cache", () => {
    expect(judgeFromEnv({ OPENAI_API_KEY: "k", STANTAL_JUDGE_CACHE_DIR: dir })?.id).toBe(
      "openai:gpt-5.4-mini",
    );
  });

  it("creates nothing on disk until something is actually recorded", () => {
    judgeFromEnv({ OPENAI_API_KEY: "k", STANTAL_JUDGE_CACHE_DIR: join(dir, "nested") });
    expect(readdirSync(dir)).toEqual([]);
  });
});
