import { describe, expect, test } from "vitest";
import { packageKey, rebuildSummary, SUMMARY_SCHEMA } from "./summary-schema.mjs";

/**
 * The receiving half of the provider direction's privacy rule.
 *
 * The CLI already builds this payload so that nothing private can be in it.
 * That is exactly why these tests exist: the day something private arrives, it
 * will be because of a change nobody thought was about privacy, and the only
 * end guaranteed to catch it is the one that never trusted the other.
 */

function valid(extra = {}) {
  return {
    schema: SUMMARY_SCHEMA,
    package: "@acme/sdk",
    from: "0.52.1",
    to: "0.62.1",
    status: "checked",
    verdict: "structurally-breaking",
    counts: { structural: 2, prose: 1, behavioural: 0, withheld: 0 },
    breaks: [{ rule: "tool_removed", target: "make_thing", subpath: "./ai-sdk", reach: "tool_reference", places: 4 }],
    reaches: 5,
    tool: "stantal@0.5.0",
    generatedAt: "2026-09-08T09:00:00.000Z",
    ...extra,
  };
}

describe("rebuildSummary", () => {
  test("accepts the payload the CLI actually sends", () => {
    const { summary, error } = rebuildSummary(valid());
    expect(error).toBeUndefined();
    expect(summary.package).toBe("@acme/sdk");
    expect(summary.counts.structural).toBe(2);
    expect(summary.breaks[0].places).toBe(4);
  });

  test("accepts the entry points a provider really has", () => {
    // `.`, `./ai-sdk` and `bin:name` are all correct subpaths, and an earlier
    // version of the leak check rejected every one of them. A boundary that
    // refuses legitimate traffic gets turned off, which is the worst outcome
    // available to a boundary.
    for (const subpath of [".", "./ai-sdk", "bin:tavily-mcp", "manifest"]) {
      const { error } = rebuildSummary(
        valid({ breaks: [{ rule: "tool_removed", target: "t", subpath, reach: "tool_reference", places: 1 }] }),
      );
      expect(error).toBeUndefined();
    }
  });

  test("refuses a field carrying a line reference", () => {
    const { error } = rebuildSummary(
      valid({
        breaks: [
          { rule: "tool_removed", target: "src/agent.ts:9", subpath: ".", reach: "tool_reference", places: 1 },
        ],
      }),
    );
    expect(error).toContain("file path");
  });

  test("refuses an absolute path, on either platform", () => {
    for (const leak of ["/home/someone/app", "C:\\Users\\someone\\app", "C:/Users/someone/app"]) {
      const { error } = rebuildSummary(valid({ package: leak }));
      expect(error).toContain("file path");
    }
  });

  /**
   * Dropped rather than refused, unlike a leak. Losing a whole summary because
   * a newer CLI added a counter would cost a provider data they need; dropping
   * the field costs them nothing they had before.
   */
  test("drops a field it does not know, and keeps the rest", () => {
    const { summary, error } = rebuildSummary(
      valid({ evidence: "src/agent.ts:9", repository: "acme/private-thing", surprise: 1 }),
    );
    expect(error).toBeUndefined();
    expect(Object.keys(summary).sort()).toEqual(
      ["breaks", "counts", "from", "generatedAt", "package", "reaches", "schema", "status", "to", "tool", "verdict"],
    );
    expect(JSON.stringify(summary)).not.toContain("private-thing");
    expect(JSON.stringify(summary)).not.toContain("src/agent.ts");
  });

  test("drops an unknown field inside a break too", () => {
    const { summary } = rebuildSummary(
      valid({
        breaks: [
          {
            rule: "tool_removed",
            target: "t",
            subpath: ".",
            reach: "tool_reference",
            places: 1,
            evidence: "src/secret.ts:12",
            detail: "tool `t` removed, and this line names it",
          },
        ],
      }),
    );
    expect(Object.keys(summary.breaks[0]).sort()).toEqual(["places", "reach", "rule", "subpath", "target"]);
    expect(JSON.stringify(summary)).not.toContain("src/secret.ts");
  });

  test("refuses a payload of another shape", () => {
    expect(rebuildSummary({ schema: "something.else/1" }).error).toContain("schema");
    expect(rebuildSummary(null).error).toContain("not an object");
    expect(rebuildSummary([]).error).toContain("not an object");
  });

  test("refuses a status or verdict it does not know", () => {
    expect(rebuildSummary(valid({ status: "fine" })).error).toContain("status");
    expect(rebuildSummary(valid({ verdict: "great" })).error).toContain("verdict");
  });

  test("a not-applicable summary is accepted, and is not a pass", () => {
    // The commonest thing this endpoint will receive: a provider's CLI running
    // in a repository that has nothing to do with them.
    const { summary, error } = rebuildSummary(
      valid({ status: "not-a-dependency", verdict: "not-applicable", from: null, to: null, breaks: [] }),
    );
    expect(error).toBeUndefined();
    expect(summary.verdict).toBe("not-applicable");
  });

  test("clamps a count rather than storing whatever arrived", () => {
    const { summary } = rebuildSummary(valid({ reaches: -5, counts: { structural: "many" } }));
    expect(summary.reaches).toBe(0);
    expect(summary.counts.structural).toBe(0);
  });
});

describe("packageKey", () => {
  test("makes one package one prefix", () => {
    expect(packageKey("@acme/sdk")).toBe("@acme+sdk");
    expect(packageKey("tavily-mcp")).toBe("tavily-mcp");
  });

  test("cannot escape its own prefix", () => {
    // The name arrives from a stranger and becomes part of an object path.
    expect(packageKey("../../etc/passwd")).not.toContain("/");
  });
});
