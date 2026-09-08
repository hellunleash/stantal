import { describe, expect, test } from "vitest";
import { exposureOf } from "./exposure.js";
import type { HistoryResult } from "./history.js";

function history(steps: Array<[string, number]>): HistoryResult {
  return {
    package: "@example/tools",
    versions: steps.map(([v]) => v),
    steps: steps.map(([version, findings]) => ({
      version,
      previous: null,
      findings,
      structuralBreaks: 0,
      unreadableSurfaces: [],
    })),
    onsets: [],
    judge: "none",
    summary: { versionsWalked: steps.length, distinctFindings: 0, unresolved: 0, alsoStructural: 0, silent: 0 },
  };
}

describe("exposureOf", () => {
  test("splits installs by whether their release carries a finding", () => {
    const result = exposureOf(history([["1.0.0", 0], ["1.1.0", 2]]), { "1.0.0": 300, "1.1.0": 700 });
    expect(result.clean).toBe(300);
    expect(result.affected).toBe(700);
    expect(result.share).toBeCloseTo(0.7);
  });

  /**
   * A tool that cannot return zero cannot be believed when it returns 100. Both
   * ends are asserted for that reason.
   */
  test("returns zero when every downloaded release is clean", () => {
    const result = exposureOf(history([["1.0.0", 0], ["1.1.0", 0]]), { "1.0.0": 10, "1.1.0": 90 });
    expect(result.affected).toBe(0);
    expect(result.share).toBe(0);
  });

  test("returns one when every downloaded release carries something", () => {
    const result = exposureOf(history([["1.0.0", 1], ["1.1.0", 5]]), { "1.0.0": 10, "1.1.0": 90 });
    expect(result.share).toBe(1);
  });

  /**
   * The invariant the rest of this codebase is built on, applied to a number.
   * A release the walk did not cover is not a release it cleared, so it may not
   * quietly improve the percentage.
   */
  test("a release the walk did not cover is counted as neither", () => {
    const result = exposureOf(history([["1.0.0", 0]]), { "1.0.0": 100, "9.9.9": 900 });
    expect(result.clean).toBe(100);
    expect(result.affected).toBe(0);
    expect(result.unwalked).toBe(900);
    // 900 unknown installs must not read as 900 clean ones.
    expect(result.share).toBe(0);
    expect(result.rows.find((r) => r.version === "9.9.9")?.state).toBe("not-walked");
  });

  test("a package nobody installed has no share, rather than a zero", () => {
    // Null, not 0. "Nobody is exposed" and "we counted nothing" are different
    // claims, and printing 0.0% for the second would be the wrong one.
    const result = exposureOf(history([["1.0.0", 1]]), {});
    expect(result.share).toBeNull();
  });

  test("ranks by installs, so the versions that matter are first", () => {
    const result = exposureOf(history([["1.0.0", 0], ["1.1.0", 1], ["1.2.0", 1]]), {
      "1.0.0": 5,
      "1.1.0": 500,
      "1.2.0": 50,
    });
    expect(result.rows.map((r) => r.version)).toEqual(["1.1.0", "1.2.0", "1.0.0"]);
  });
});
