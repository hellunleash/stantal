import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyReplay, main } from "./cli.js";

/**
 * The CLI's flag plumbing, tested where it can be tested without a network.
 *
 * Everything here stops before `buildReport` — a refusal, a validation error,
 * or a pure function. The layers themselves are covered by their own suites;
 * what is worth pinning at this level is the promises the flags make, because
 * those are made in prose in `USAGE` and kept in code somewhere else.
 */

let stderr: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  stderr = "";
  saved = { ...process.env };
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  // `main` calls `loadDotEnv`, which mutates the real environment. Without this
  // a machine with a `.env` and one without would run different tests.
  process.env = saved;
  vi.restoreAllMocks();
});

describe("applyReplay", () => {
  it("silences every layer that can call out, not just the judge", () => {
    // The flag says the run cannot spend. When Layer 2 arrived, setting only
    // the judge's cache would have left that promise false while still being
    // printed in --help.
    const env: NodeJS.ProcessEnv = {};
    applyReplay(env);
    expect(env["STANTAL_JUDGE_CACHE"]).toBe("replay");
    expect(env["STANTAL_BEHAVIOUR_CACHE"]).toBe("replay");
  });
});

describe("--behaviour", () => {
  it("is refused on a history walk rather than quietly ignored", async () => {
    // A walk runs the pair logic once per release, so Layer 2 there is k calls
    // per request per side times every version in the range. Ignoring the flag
    // would be safe; accepting it would be very expensive. Saying so is better
    // than either.
    const code = await main(["history", "example", "--behaviour"]);
    expect(code).toBe(2);
    expect(stderr).toContain("not available on a history walk");
  });

  it("warns and carries on when no key is set, rather than failing", async () => {
    process.env["STANTAL_CALLER"] = "none";
    // No positionals, so this returns on usage before touching the network. The
    // point is only that asking for Layer 2 without a key is not fatal here.
    const code = await main(["--behaviour"]);
    expect(code).toBe(2);
    expect(stderr).toContain("stantal —");
  });
});

describe("--k", () => {
  it("refuses a value that is not a positive whole number", async () => {
    process.env["STANTAL_CALLER"] = "openai";
    process.env["OPENAI_API_KEY"] = "test-key-never-used";
    const code = await main(["example", "1.0.0", "2.0.0", "--behaviour", "--k", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--k must be a positive whole number");
  });
});

describe("--k validation", () => {
  it("warns rather than silently dropping it when --behaviour is absent", async () => {
    // Parsed on every path, so the same argument means the same thing whether
    // or not a key happens to be present.
    // No positionals, so this stops at usage without touching the network. The
    // warning still has to have been printed by then, which is the point: an
    // argument is judged before any work is done on its behalf.
    const code = await main(["--k", "8"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--k only applies with --behaviour");
  });

  it("rejects a value parseInt would silently truncate", async () => {
    // `parseInt("1e3")` is 1, which would hand the weakest possible sample to
    // someone asking for the strongest.
    const code = await main(["--k", "1e3"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--k must be a positive whole number");
  });
});
