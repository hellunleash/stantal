import { describe, expect, it } from "vitest";
import type { HistoryResult, HistoryStep, Onset } from "../history.js";
import { planRemedy } from "./plan.js";
import { movesVersion } from "./taxonomy.js";

const VERSIONS = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"];

function onset(partial: Partial<Onset> = {}): Onset {
  return {
    key: "./x|undocumented_optional|make.target",
    subpath: "./x",
    rule: "undocumented_optional",
    target: "make.target",
    severity: "medium",
    headline: "`target` is optional and undocumented",
    introducedAt: "1.1.0",
    lastCleanVersion: "1.0.0",
    resolvedAt: null,
    releasesAffected: 4,
    ...partial,
  };
}

function step(version: string, unreadableSurfaces: string[] = []): HistoryStep {
  return { version, previous: null, findings: 0, structuralBreaks: 0, unreadableSurfaces };
}

function walk(partial: Partial<HistoryResult> = {}): HistoryResult {
  return {
    package: "example",
    versions: VERSIONS,
    steps: VERSIONS.map((v) => step(v)),
    onsets: [onset()],
    judge: "none",
    summary: { versionsWalked: 5, distinctFindings: 1, unresolved: 1, alsoStructural: 0, silent: 1 },
    ...partial,
  };
}

describe("nearest clean, never latest", () => {
  it("recommends the smallest hop that clears the reason you are stuck", () => {
    // Defect runs 1.1.0 → 1.2.0 and is gone from 1.3.0. Latest is 1.4.0, and
    // recommending it would hand the consumer 1.3.0's changes as well for no
    // reason they asked for.
    const result = planRemedy({
      walk: walk({ onsets: [onset({ resolvedAt: "1.3.0" })] }),
      current: "1.1.0",
    });

    expect(result.kind).toBe("upgrade");
    expect(result.target).toBe("1.3.0");
    expect(result.latest).toBe("1.4.0");
    expect(result.headline).toContain("latest is 1.4.0");
  });

  it("searches forward only", () => {
    // A consumer asking whether to take an upgrade is not asking to be sent
    // backwards, and the older release carries deltas nothing here measured.
    const result = planRemedy({
      walk: walk({ onsets: [onset({ introducedAt: "1.0.0", lastCleanVersion: null, resolvedAt: "1.1.0" })] }),
      current: "1.0.0",
    });
    expect(result.target).not.toBe("1.0.0");
  });

  it("says so when the consumer is clean and has somewhere to go", () => {
    // Clean now, and 1.3.0 ahead is clean too. Nothing forces a move.
    const result = planRemedy({
      walk: walk({
        onsets: [onset({ introducedAt: "1.2.0", lastCleanVersion: "1.1.0", resolvedAt: "1.3.0" })],
      }),
      current: "1.1.0",
    });
    expect(result.kind).toBe("stay");
    expect(movesVersion(result)).toBe(false);
    expect(result.hold).toBeUndefined();
  });

  it("clean now but nowhere to go is stranded, not fine", () => {
    // The case this product exists for, and the spec's own worked example: you
    // are on a good version and every release after it carries the defect.
    // Reporting this as "stay" would be true about the bytes in use, and would
    // hide that the exit is closed.
    const result = planRemedy({
      walk: walk({ onsets: [onset({ introducedAt: "1.2.0", lastCleanVersion: "1.1.0" })] }),
      current: "1.1.0",
    });
    expect(result.kind).toBe("stuck");
    expect(result.target).toBeNull();
    expect(result.headline).toContain("nowhere to upgrade to");
    // The hold is the whole point: it names what must clear, and a later walk
    // re-checks it rather than a person re-reading a comment.
    expect(result.hold?.heldAt).toBe("1.1.0");
    expect(result.hold?.until).toHaveLength(1);
  });
});

describe("no clean version is a real answer", () => {
  it("returns patch rather than inventing a version", () => {
    // The defect arrives at 1.1.0 and never resolves. A nearest-clean search
    // that cannot come back empty would fabricate a number here, and a
    // fabricated version is checkable, fails, and takes the report with it.
    const result = planRemedy({ walk: walk(), current: "1.1.0" });

    expect(result.kind).toBe("patch");
    expect(result.target).toBeNull();
    expect(result.headline).toContain("no release is clean");
  });

  it("carries a hold with a predicate a later walk can re-check", () => {
    // A pin is a hold, not a remedy. What makes it survivable is that the
    // reason is a predicate rather than a comment, so it lifts itself.
    const result = planRemedy({ walk: walk(), current: "1.1.0" });

    expect(result.hold).toMatchObject({ package: "example", heldAt: "1.1.0", stillPresentAt: "1.4.0" });
    expect(result.hold?.until).toEqual([
      { key: "./x|undocumented_optional|make.target", rule: "undocumented_optional", target: "make.target", subpath: "./x" },
    ]);
  });

  it("does not attach a hold when the consumer is being moved", () => {
    const result = planRemedy({
      walk: walk({ onsets: [onset({ resolvedAt: "1.3.0" })] }),
      current: "1.1.0",
    });
    expect(result.hold).toBeUndefined();
  });
});

describe("a version nobody could read is not a clean version", () => {
  it("skips an unreadable release instead of recommending it", () => {
    // Silence from a failed extraction looks exactly like silence from a clean
    // contract. Only one of them is safe to move into, and recommending the
    // other is the worst output this product could produce.
    const result = planRemedy({
      walk: walk({
        onsets: [onset({ resolvedAt: "1.2.0" })],
        steps: [step("1.0.0"), step("1.1.0"), step("1.2.0", ["./x"]), step("1.3.0"), step("1.4.0")],
      }),
      current: "1.1.0",
    });

    expect(result.target).toBe("1.3.0");
    expect(result.unverifiable).toEqual(["1.2.0"]);
  });

  it("reports the skipped releases rather than dropping them", () => {
    // A hop declined because it could not be verified is a different answer
    // from one that was never seen, and the consumer may want to check it.
    const result = planRemedy({
      walk: walk({
        onsets: [onset()],
        steps: VERSIONS.map((v) => step(v, v === "1.0.0" ? [] : ["./x"])),
      }),
      current: "1.1.0",
    });
    expect(result.unverifiable).toEqual(["1.2.0", "1.3.0", "1.4.0"]);
    expect(result.kind).toBe("patch");
  });
});

describe("whose defect it is", () => {
  it("upgrading is not free when the consumer's call sites move", () => {
    // Being told to "just upgrade" about a change that breaks your code is how
    // a tool loses someone in one step.
    const result = planRemedy({
      walk: walk({ onsets: [onset({ resolvedAt: "1.3.0" })] }),
      current: "1.1.0",
      callSitesAffected: true,
    });
    expect(result.kind).toBe("migrate");
    expect(result.target).toBe("1.3.0");
    expect(result.headline).toContain("call sites move too");
  });

  it("separates a local fix from a patch of someone else's package", () => {
    const result = planRemedy({ walk: walk(), current: "1.1.0", callSitesAffected: true });
    expect(result.kind).toBe("fix_locally");
    expect(result.headline).toContain("how you call it");
  });

  it("defaults to the provider's side, which is where prose defects live", () => {
    // You cannot add a description to someone else's package.
    expect(planRemedy({ walk: walk(), current: "1.1.0" }).kind).toBe("patch");
  });
});

describe("refusing to answer", () => {
  it("will not plan against a version that was never walked", () => {
    const result = planRemedy({ walk: walk(), current: "9.9.9" });
    expect(result.kind).toBe("unknown");
    expect(result.target).toBeNull();
    expect(result.headline).toContain("not among the releases walked");
  });

  it("will not plan against an empty walk", () => {
    const result = planRemedy({ walk: walk({ versions: [], steps: [], onsets: [] }) });
    expect(result.kind).toBe("unknown");
    expect(result.latest).toBeNull();
  });

  it("assumes the oldest release walked, which is the stranded case", () => {
    const result = planRemedy({ walk: walk() });
    expect(result.hold?.heldAt).toBe("1.0.0");
    expect(result.kind).toBe("stuck");
  });
});
