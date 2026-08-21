import { describe, expect, test } from "vitest";
import { toolsFromListResult } from "./mcp.js";

/**
 * Fixture-backed: a `tools/list` payload is captured once and replayed, so
 * booting a server is never part of the test loop.
 */
const TOOLS_LIST_RESULT = {
  tools: [
    {
      name: "build",
      description: "Build or edit a screen.",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string", minLength: 1, description: "What to build." },
          context: { type: "string" },
          target: { type: "string", minLength: 1 },
          slot: { type: "string" },
        },
        required: ["request"],
      },
    },
    {
      name: "pin",
      description: "Move an existing screen into a slot.",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" }, slot: { type: "string" } },
        required: ["target", "slot"],
      },
    },
  ],
};

describe("toolsFromListResult", () => {
  test("normalizes every tool in the listing", () => {
    const tools = toolsFromListResult(TOOLS_LIST_RESULT);
    expect(tools.map((t) => t.name)).toEqual(["build", "pin"]);
  });

  test("sorts by name so two versions compare without spurious diffs", () => {
    const reversed = { tools: [...TOOLS_LIST_RESULT.tools].reverse() };
    expect(toolsFromListResult(reversed).map((t) => t.name)).toEqual(
      toolsFromListResult(TOOLS_LIST_RESULT).map((t) => t.name),
    );
  });

  test("carries the undocumented optional parameter through as null", () => {
    const build = toolsFromListResult(TOOLS_LIST_RESULT).find((t) => t.name === "build");
    const target = build?.params.find((p) => p.name === "target");

    expect(target?.description).toBeNull();
    expect(target?.required).toBe(false);
  });

  test("drops entries with no usable name rather than emitting junk tools", () => {
    const tools = toolsFromListResult({ tools: [{ description: "no name" }, { name: "" }] });
    expect(tools).toEqual([]);
  });

  test("survives a malformed listing", () => {
    expect(toolsFromListResult(undefined)).toEqual([]);
    expect(toolsFromListResult({})).toEqual([]);
    expect(toolsFromListResult({ tools: "nope" })).toEqual([]);
  });
});
