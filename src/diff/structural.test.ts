import { describe, expect, test } from "vitest";
import type { Contract } from "../contract/types.js";
import { diffStructural } from "./structural.js";

/**
 * An optional parameter appears on an existing tool, carrying no description.
 * Every structural check passes.
 */
describe("diffStructural — an undocumented optional parameter is not caller-breaking", () => {
  const before: Contract = {
    ecosystem: "npm",
    package: "example",
    version: "1.0.0",
    surface: "mcp-server",
    extractedAt: "1970-01-01T00:00:00.000Z",
    extractorVersion: "fixture",
    tools: [
      {
        name: "make",
        description: "Build a thing.",
        params: [
          { name: "request", type: "string", required: true, description: "What to build.", constraints: {} },
        ],
      },
    ],
  };

  const after: Contract = {
    ...before,
    version: "1.1.0",
    tools: [
      {
        name: "make",
        description: "Build a thing.",
        params: [
          { name: "request", type: "string", required: true, description: "What to build.", constraints: {} },
          { name: "target", type: "string", required: false, description: null, constraints: { minLength: 1 } },
        ],
      },
    ],
  };

  test("reports the addition but does not call it breaking", () => {
    const diff = diffStructural(before, after);

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]?.rule).toBe("param_added_optional");
    expect(diff.changes[0]?.breaking).toBe(false);
    expect(diff.breaking).toBe(false);
  });

  test("notes the absent description without judging it", () => {
    const diff = diffStructural(before, after);
    expect(diff.changes[0]?.note).toContain("no description");
  });

  test("names the changed tool so callers can narrow later work", () => {
    expect(diffStructural(before, after).changedTools).toEqual(["make"]);
  });
});

describe("diffStructural — caller-breaking changes", () => {
  const base: Contract = {
    ecosystem: "npm",
    package: "example",
    version: "1.0.0",
    surface: "mcp-server",
    extractedAt: "1970-01-01T00:00:00.000Z",
    extractorVersion: "fixture",
    tools: [
      {
        name: "t",
        description: null,
        params: [
          { name: "a", type: "string", required: false, description: null, constraints: { maxLength: 10, enum: ["x", "y"] } },
        ],
      },
    ],
  };

  function withParam(patch: Partial<(typeof base.tools)[0]["params"][0]>): Contract {
    const p = base.tools[0]!.params[0]!;
    return {
      ...base,
      version: "2.0.0",
      tools: [{ ...base.tools[0]!, params: [{ ...p, ...patch }] }],
    };
  }

  test("a new required parameter is breaking", () => {
    const after: Contract = {
      ...base,
      version: "2.0.0",
      tools: [
        {
          ...base.tools[0]!,
          params: [
            base.tools[0]!.params[0]!,
            { name: "b", type: "string", required: true, description: null, constraints: {} },
          ],
        },
      ],
    };
    const diff = diffStructural(base, after);
    expect(diff.changes[0]?.rule).toBe("param_added_required");
    expect(diff.breaking).toBe(true);
  });

  test("a type change is breaking", () => {
    expect(diffStructural(base, withParam({ type: "number" })).breaking).toBe(true);
  });

  test("becoming required is breaking; becoming optional is not", () => {
    expect(diffStructural(base, withParam({ required: true })).breaking).toBe(true);

    const requiredFirst: Contract = {
      ...base,
      tools: [{ ...base.tools[0]!, params: [{ ...base.tools[0]!.params[0]!, required: true }] }],
    };
    expect(diffStructural(requiredFirst, base).breaking).toBe(false);
  });

  test("narrowing an enum is breaking; widening it is not", () => {
    expect(diffStructural(base, withParam({ constraints: { maxLength: 10, enum: ["x"] } })).breaking).toBe(true);
    expect(
      diffStructural(base, withParam({ constraints: { maxLength: 10, enum: ["x", "y", "z"] } })).breaking,
    ).toBe(false);
  });

  test("tightening a bound is breaking; relaxing it is not", () => {
    expect(diffStructural(base, withParam({ constraints: { maxLength: 5, enum: ["x", "y"] } })).breaking).toBe(true);
    expect(diffStructural(base, withParam({ constraints: { maxLength: 20, enum: ["x", "y"] } })).breaking).toBe(false);
  });

  test("removing a tool is breaking", () => {
    const empty: Contract = { ...base, version: "2.0.0", tools: [] };
    const diff = diffStructural(base, empty);
    expect(diff.changes[0]?.rule).toBe("tool_removed");
    expect(diff.breaking).toBe(true);
  });

  test("adding a tool is not breaking", () => {
    const more: Contract = {
      ...base,
      version: "2.0.0",
      tools: [...base.tools, { name: "u", description: null, params: [] }],
    };
    expect(diffStructural(base, more).breaking).toBe(false);
  });
});

describe("diffStructural — nested params", () => {
  const base: Contract = {
    ecosystem: "npm",
    package: "example",
    version: "1.0.0",
    surface: "mcp-server",
    extractedAt: "1970-01-01T00:00:00.000Z",
    extractorVersion: "fixture",
    tools: [
      {
        name: "t",
        description: null,
        params: [
          {
            name: "target",
            type: "object",
            required: true,
            description: null,
            constraints: {},
            children: [{ name: "id", type: "string", required: true, description: null, constraints: {} }],
          },
        ],
      },
    ],
  };

  test("sees a change three levels down and paths it correctly", () => {
    const after: Contract = {
      ...base,
      version: "2.0.0",
      tools: [
        {
          ...base.tools[0]!,
          params: [
            {
              ...base.tools[0]!.params[0]!,
              children: [{ name: "id", type: "number", required: true, description: null, constraints: {} }],
            },
          ],
        },
      ],
    };
    const diff = diffStructural(base, after);
    expect(diff.changes[0]?.rule).toBe("param_type_changed");
    expect(diff.changes[0]?.target).toBe("t.target.id");
  });
});
