import { describe, expect, it } from "vitest";
import { EXTRACTOR_VERSION, type Contract, type Param, type Tool } from "../contract/types.js";
import { breakingBump, changedTools, modeForBump, selectIntents, type Intent } from "./intent.js";

function param(name: string, extra: Partial<Param> = {}): Param {
  return { name, type: "string", required: false, description: null, constraints: {}, ...extra };
}

function tool(name: string, params: Param[] = [], description: string | null = "d"): Tool {
  return { name, description, params };
}

function contract(tools: Tool[]): Contract {
  return {
    ecosystem: "npm",
    package: "example",
    version: "1.0.0",
    surface: "host-pack",
    extractedAt: "2026-01-01T00:00:00.000Z",
    extractorVersion: EXTRACTOR_VERSION,
    tools,
  };
}

function intent(id: string, slice: string[], expectsNoCall = false): Intent {
  return { id, text: `do ${id}`, slice, expectsNoCall };
}

describe("changedTools", () => {
  it("sees a reworded description, which is the whole point of the product", () => {
    const before = contract([tool("make", [], "old wording")]);
    const after = contract([tool("make", [], "new wording")]);
    expect([...changedTools(before, after)]).toEqual(["make"]);
  });

  it("sees a parameter description change", () => {
    const before = contract([tool("make", [param("a")])]);
    const after = contract([tool("make", [param("a", { description: "now explained" })])]);
    expect([...changedTools(before, after)]).toEqual(["make"]);
  });

  it("sees a tool that was removed", () => {
    const before = contract([tool("make"), tool("edit")]);
    const after = contract([tool("make")]);
    expect([...changedTools(before, after)]).toEqual(["edit"]);
  });

  it("says nothing changed when nothing did", () => {
    const before = contract([tool("make", [param("a")])]);
    const after = contract([tool("make", [param("a")])]);
    expect([...changedTools(before, after)]).toEqual([]);
  });

  it("treats a first version as all-changed", () => {
    expect([...changedTools(null, contract([tool("a"), tool("b")]))].sort()).toEqual(["a", "b"]);
  });
});

describe("selectIntents", () => {
  const corpus = [intent("i1", ["make"]), intent("i2", ["edit"]), intent("i3", ["make", "edit"])];

  it("replays only the intents whose slice changed", () => {
    const picked = selectIntents(corpus, new Set(["make"]), "affected");
    expect(picked.map((i) => i.id)).toEqual(["i1", "i3"]);
  });

  it("replays everything in full mode", () => {
    expect(selectIntents(corpus, new Set(["make"]), "full")).toHaveLength(3);
  });

  it("always runs an untagged intent", () => {
    // An untagged intent is not cheap, it is unknown. Skipping unknowns is how
    // a selection optimisation turns into a missed finding.
    const picked = selectIntents([...corpus, intent("i4", [])], new Set(["nothing"]), "affected");
    expect(picked.map((i) => i.id)).toEqual(["i4"]);
  });

  it("always runs a no-call control", () => {
    // Any change anywhere can make the model start calling something.
    const control = intent("c1", ["make"], true);
    const picked = selectIntents([control], new Set(["unrelated"]), "affected");
    expect(picked.map((i) => i.id)).toEqual(["c1"]);
  });
});

describe("breakingBump", () => {
  it("treats a major change as breaking", () => {
    expect(breakingBump("1.4.0", "2.0.0")).toBe(true);
  });

  it("treats a 1.x minor and patch as not breaking", () => {
    expect(breakingBump("1.4.0", "1.5.0")).toBe(false);
    expect(breakingBump("1.4.0", "1.4.9")).toBe(false);
  });

  it("treats a 0.x minor as breaking, because npm does", () => {
    // `^0.7.0` does not match `0.24.0`. Reading this as a minor bump would trim
    // the corpus on exactly the bumps most likely to move behaviour — and the
    // anchoring case is 0.7.0 -> 0.24.0.
    expect(breakingBump("0.7.0", "0.24.0")).toBe(true);
    expect(breakingBump("0.7.0", "0.7.3")).toBe(false);
  });

  it("ignores a prerelease tag", () => {
    expect(breakingBump("1.4.0", "1.5.0-alpha.2")).toBe(false);
  });

  it("drives the selection mode", () => {
    expect(modeForBump("0.7.0", "0.24.0")).toBe("full");
    expect(modeForBump("1.4.0", "1.4.1")).toBe("affected");
  });
});
