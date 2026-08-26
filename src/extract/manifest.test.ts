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

describe("a contract split across documents", () => {
  /**
   * A host commonly generates schemas from its own routes and keeps the prose
   * somewhere a person edits. What a model receives is the merge, so reading
   * only the file named `tools` reports real schemas beside descriptions that
   * are not the ones shipped.
   */
  const CATALOG = {
    tools: [
      { name: "remove_member", description: "DELETE /api/member/{id}", inputSchema: {
        type: "object", properties: { id: { type: "string" }, role: { type: "string" } }, required: ["id"] } },
      { name: "ping", description: "GET /api/ping" },
    ],
  };

  const PROSE = {
    tools: [
      { name: "remove_member", description: "Removes one member from the caller's org. Owner-only." },
      { name: "ping", description: "Liveness probe. Never mutates anything." },
    ],
  };

  function merge(sources: unknown[], extra: Record<string, unknown> = {}) {
    return extractFromManifest({
      sources: sources.map((s, i) => ({ text: JSON.stringify(s), origin: `doc${i}.json` })),
      package: "example-host",
      version: "1",
      ...extra,
    });
  }

  test("prose from a later document reaches the contract", () => {
    const result = merge([CATALOG, PROSE]);
    if (!isPresent(result)) throw new Error("expected a contract");

    const remove = result.contract.tools.find((t) => t.name === "remove_member")!;
    expect(remove.description).toBe("Removes one member from the caller's org. Owner-only.");
    // The schema still comes from the catalog. A document that carries prose
    // and no schema must not erase the parameters.
    expect(remove.params.map((p) => p.name)).toEqual(["id", "role"]);
  });

  test("the catalog defines the tool set, so a stale annotation adds nothing", () => {
    // An annotation file cannot introduce a tool the host does not serve, and
    // turning one into a tool with prose and no schema would invent a contract.
    const stale = { tools: [...PROSE.tools, { name: "deleted_tool", description: "gone" }] };
    const result = merge([CATALOG, stale]);
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools.map((t) => t.name)).toEqual(["ping", "remove_member"]);
  });

  test("order decides which document wins", () => {
    const result = merge([PROSE, CATALOG]);
    if (!isPresent(result)) throw new Error("expected a contract");
    // Prose first makes prose the catalog, so the route strings now win.
    expect(result.contract.tools.find((t) => t.name === "ping")!.description).toBe("GET /api/ping");
  });

  test("a gap in one document is not cleared by another", () => {
    // The later document says nothing about the schema. Treating silence as
    // "readable now" would report parameters that were never read.
    const broken = { tools: [{ name: "remove_member", inputSchema: "ArgsSchema" }, { name: "ping" }] };
    const result = merge([broken, PROSE]);
    if (!isPresent(result)) throw new Error("expected a contract");

    expect(result.notes.some((n) => n.scope === "schema" && n.target === "remove_member")).toBe(true);
    expect(result.contract.tools.find((t) => t.name === "remove_member")!.params).toEqual([]);
  });

  test("an unreadable document is an absence, not a partial merge", () => {
    const result = merge([CATALOG, "{ not json"]);
    if (result.present) throw new Error("expected an absence");
    expect(result.absence.reason).toBe("unparseable");
  });
});

describe("nested descriptor fields", () => {
  const NESTED = {
    tools: [
      {
        name: "run",
        description: "POST /api/run",
        fields: { description: "Starts a job and returns its id.", audience: "end-user" },
      },
    ],
  };

  test("reads fields from the wrapper the caller names", () => {
    const result = extractFromManifest({
      text: JSON.stringify(NESTED),
      package: "h",
      version: "1",
      fieldsKey: "fields",
    });
    if (!isPresent(result)) throw new Error("expected a contract");
    // The wrapper wins: it holds what a person wrote, and the outer copy is the
    // generated value it supersedes.
    expect(result.contract.tools[0]!.description).toBe("Starts a job and returns its id.");
  });

  test("leaves the nesting alone unless told where it is", () => {
    // Sniffing for a wrapper would read the wrong object the first time a
    // producer picked a different name, and a description read off the wrong
    // object is the false finding this tool exists to catch.
    const result = extractFromManifest({ text: JSON.stringify(NESTED), package: "h", version: "1" });
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools[0]!.description).toBe("POST /api/run");
  });
});

describe("tools the runtime withholds", () => {
  const MIXED = {
    tools: [
      { name: "public_read", description: "For anyone.", audience: "end-user" },
      { name: "internal_webhook", description: "Not for the model.", audience: "internal" },
      { name: "switched_off", description: "Off.", disabled: true },
    ],
  };

  const read = (excludeWhen: Array<{ key: string; value: string }>) =>
    extractFromManifest({ text: JSON.stringify(MIXED), package: "h", version: "1", excludeWhen });

  test("excludes what the caller says the host hides", () => {
    const result = read([{ key: "audience", value: "internal" }, { key: "disabled", value: "true" }]);
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools.map((t) => t.name)).toEqual(["public_read"]);
  });

  test("withholds nothing unless asked, since the rule is not ours to infer", () => {
    const result = read([]);
    if (!isPresent(result)) throw new Error("expected a contract");
    expect(result.contract.tools).toHaveLength(3);
  });

  test("excluding everything is an absence, never an empty contract", () => {
    // An empty contract diffs as "every tool removed", which is a loud and
    // false finding about the other side.
    const result = read([{ key: "description", value: "For anyone." }, { key: "audience", value: "internal" }, { key: "disabled", value: "true" }]);
    expect(result.present).toBe(false);
  });
});
