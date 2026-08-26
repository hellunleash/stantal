import { describe, expect, test } from "vitest";
import { isEvidencedAbsence, isPresent } from "../contract/surface.js";
import { extractFromManifest } from "./manifest.js";

function read(body: unknown, origin = "tools.json") {
  return extractFromManifest({
    text: typeof body === "string" ? body : JSON.stringify(body),
    package: "example-host",
    version: "1",
    origin,
  });
}

const SEARCH = {
  name: "search",
  description: "Search the catalogue.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for." },
      limit: { type: "number" },
    },
    required: ["query"],
  },
};

describe("extractFromManifest", () => {
  test("reads a serialized descriptor whole", () => {
    const result = read({ tools: [SEARCH] });
    if (!isPresent(result)) throw new Error("expected a contract");

    expect(result.fidelity).toBe("complete");
    expect(result.notes).toEqual([]);
    expect(result.contract.tools).toHaveLength(1);

    const tool = result.contract.tools[0]!;
    expect(tool.name).toBe("search");
    expect(tool.description).toBe("Search the catalogue.");
    expect(tool.params.map((p) => [p.name, p.required, p.description])).toEqual([
      ["query", true, "What to look for."],
      ["limit", false, null],
    ]);
  });

  test("tools come back sorted, so two versions compare cleanly", () => {
    const result = read({ tools: [{ name: "zeta" }, { name: "alpha" }, { name: "mid" }] });
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools.map((t) => t.name)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("where the list is", () => {
  test("finds it under `tools`", () => {
    expect(isPresent(read({ tools: [SEARCH] }))).toBe(true);
  });

  test("finds it inside a captured JSON-RPC reply", () => {
    const result = read({ jsonrpc: "2.0", id: 1, result: { tools: [SEARCH] } });
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools[0]!.name).toBe("search");
  });

  test("accepts a bare array of descriptors", () => {
    const result = read([SEARCH]);
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools[0]!.name).toBe("search");
  });

  test("a bare array of things that are not descriptors is not a tool list", () => {
    const result = read([1, 2, 3]);
    expect(result.present).toBe(false);
  });
});

describe("absent is not empty", () => {
  test("an empty list is an evidenced absence", () => {
    const result = read({ tools: [] });
    if (result.present) throw new Error("expected an absence");
    // The file is a manifest and it says there are none. That claim is earned,
    // so a later version adding tools is a real addition.
    expect(result.absence.reason).toBe("no_descriptors");
    expect(isEvidencedAbsence(result.absence.reason)).toBe(true);
  });

  test("unreadable JSON is an unevidenced absence", () => {
    const result = read("{ not json");
    if (result.present) throw new Error("expected an absence");
    expect(result.absence.reason).toBe("unparseable");
    expect(isEvidencedAbsence(result.absence.reason)).toBe(false);
  });

  test("JSON with no tool list is unparseable, never `no tools`", () => {
    // The distinction is the whole point. Calling this "lists no tools" would
    // claim something about a file we have no reason to think is a manifest.
    const result = read({ theme: "dark", fonts: [] });
    if (result.present) throw new Error("expected an absence");
    expect(result.absence.reason).toBe("unparseable");
    expect(isEvidencedAbsence(result.absence.reason)).toBe(false);
  });

  test("every entry unreadable is our limit, not their absence", () => {
    const result = read({ tools: [{ id: 1 }, { id: 2 }] });
    if (result.present) throw new Error("expected an absence");
    expect(result.absence.reason).toBe("descriptors_unreadable");
    expect(isEvidencedAbsence(result.absence.reason)).toBe(false);
  });
});

describe("gaps are noted, never swallowed", () => {
  test("an entry with no name puts the tool set in question", () => {
    const result = read({ tools: [SEARCH, { description: "nameless" }] });
    if (!isPresent(result)) throw new Error("expected a contract");

    expect(result.fidelity).toBe("partial");
    expect(result.notes).toHaveLength(1);
    const note = result.notes[0]!;
    expect(note.code).toBe("descriptor_name_unresolved");
    expect(note.scope).toBe("surface");
    expect(note.evidence).toBe("tools.json#/tools/1");
  });

  test("an unreadable schema scopes the gap to that tool", () => {
    const result = read({ tools: [{ name: "run", inputSchema: "RunArgsSchema" }] });
    if (!isPresent(result)) throw new Error("expected a contract");

    const note = result.notes[0]!;
    expect(note.code).toBe("descriptor_schema_unresolved");
    expect(note.scope).toBe("schema");
    expect(note.target).toBe("run");
    // The tool is still reported. Only its parameters are unknown.
    expect(result.contract.tools[0]!.name).toBe("run");
    expect(result.contract.tools[0]!.params).toEqual([]);
  });

  test("unreadable properties is the same gap one level down", () => {
    const result = read({
      tools: [{ name: "run", inputSchema: { type: "object", properties: "$ref" } }],
    });
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.notes[0]!.code).toBe("descriptor_schema_unresolved");
    expect(result.notes[0]!.scope).toBe("schema");
  });

  test("no inputSchema at all is a zero-argument tool, not a gap", () => {
    // A tool that takes nothing is ordinarily serialized with the key absent.
    // Noting it would suppress real claims about a tool we read perfectly well.
    const result = read({ tools: [{ name: "ping", description: "Check liveness." }] });
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.notes).toEqual([]);
    expect(result.fidelity).toBe("complete");
    expect(result.contract.tools[0]!.params).toEqual([]);
  });

  test("a name declared twice stops being trusted", () => {
    const result = read({ tools: [{ name: "run" }, { name: "run" }] });
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools).toHaveLength(1);
    expect(result.notes[0]!.code).toBe("duplicate_descriptor");
    expect(result.notes[0]!.scope).toBe("surface");
  });
});

describe("schema spellings", () => {
  test("reads `input_schema` and `parameters` as well as `inputSchema`", () => {
    const shape = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    for (const key of ["inputSchema", "input_schema", "parameters"]) {
      const result = read({ tools: [{ name: "open", [key]: shape }] });
      if (!isPresent(result)) throw new Error(`expected a contract for ${key}`);
      expect(result.contract.tools[0]!.params.map((p) => p.name)).toEqual(["path"]);
    }
  });
});

describe("identity", () => {
  test("carries the caller's identity, since a file has none of its own", () => {
    const result = extractFromManifest({
      text: JSON.stringify({ tools: [SEARCH] }),
      package: "acme/host",
      version: "2026-01-01",
      surface: "http-discovery",
      ecosystem: "http",
    });
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.package).toBe("acme/host");
    expect(result.contract.version).toBe("2026-01-01");
    expect(result.contract.surface).toBe("http-discovery");
  });
});
