import { describe, expect, it } from "vitest";
import { memoryRepoSource } from "../blast/repo.js";
import { baselineSlug, discoverHostContracts } from "./discover.js";

const SKELETON = JSON.stringify({
  tools: [
    {
      name: "host_get_record",
      description: "GET /api/candidates/{id}",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "host_list_records",
      description: "GET /api/jobs",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    },
  ],
});

// The prose half of a split contract: keyed by tool name, no schemas, and no
// `name` field anywhere in it.
const JUDGMENTS = JSON.stringify({
  tools: {
    host_get_record: { description: "Fetch one candidate by id. Pass the id, not the email." },
    host_list_records: { description: "List open jobs. Pass limit only when a short list was asked for." },
  },
});

describe("finding a contract the repo writes", () => {
  it("reads a host-generated tool list out of a dot directory", () => {
    const found = discoverHostContracts(
      memoryRepoSource({ "package.json": "{}", ".agent/tools.json": SKELETON }),
    );
    expect(found.contracts).toHaveLength(1);
    expect(found.contracts[0]?.catalog).toBe(".agent/tools.json");
    expect(found.contracts[0]?.tools).toBe(2);
  });

  it("is not fooled by ordinary config", () => {
    const found = discoverHostContracts(
      memoryRepoSource({
        "package.json": JSON.stringify({ name: "app", dependencies: { vitest: "^2" } }),
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
        "data/cities.json": JSON.stringify([{ name: "Lisbon", population: 545796 }]),
      }),
    );
    expect(found.contracts).toEqual([]);
  });

  it("never reads its own baseline back as a contract", () => {
    // The stored copy is a tool manifest by construction. Counted, it would
    // double every contract in the repo and then diff a copy against itself.
    const found = discoverHostContracts(
      memoryRepoSource({
        ".agent/tools.json": SKELETON,
        ".stantal/contracts/agent-tools/0-tools.json": SKELETON,
      }),
    );
    expect(found.contracts.map((c) => c.catalog)).toEqual([".agent/tools.json"]);
  });
});

describe("a contract split across documents", () => {
  it("merges the annotation file after the catalog", () => {
    const found = discoverHostContracts(
      memoryRepoSource({ ".agent/tools.json": SKELETON, ".agent/judgments.json": JUDGMENTS }),
    );
    expect(found.contracts).toHaveLength(1);
    expect(found.contracts[0]?.sources).toEqual([".agent/tools.json", ".agent/judgments.json"]);
  });

  it("makes the document carrying schemas the catalog, whatever it is called", () => {
    // Order on disk is alphabetical and says nothing. Only the generated half
    // can define the tool set, and it is the half with the parameters.
    const found = discoverHostContracts(
      memoryRepoSource({ ".agent/a-prose.json": JUDGMENTS, ".agent/z-schemas.json": SKELETON }),
    );
    expect(found.contracts[0]?.catalog).toBe(".agent/z-schemas.json");
    expect(found.contracts[0]?.sources[1]).toBe(".agent/a-prose.json");
  });

  it("keeps two unrelated contracts in one directory apart", () => {
    // Merging them would report every tool of each as missing from the other.
    const other = JSON.stringify({
      tools: [{ name: "billing_refund", description: "POST /api/refunds", inputSchema: { type: "object", properties: { id: { type: "string" } } } }],
    });
    const found = discoverHostContracts(
      memoryRepoSource({ ".mcp/tools.json": SKELETON, ".mcp/billing.json": other }),
    );
    expect(found.contracts).toHaveLength(2);
    expect(found.contracts.every((c) => c.sources.length === 1)).toBe(true);
  });
});

describe("the half we could not read", () => {
  // The real host nests every editable field under `fields`. Without being told
  // where they live, that document reads as no contract at all, the snapshot
  // watches the skeleton alone, and the prose a model actually receives is
  // never compared — the exact mistake this feature exists to prevent.
  const NESTED = JSON.stringify({
    tools: {
      host_get_record: { binding: "GET /api/candidates/{}", fields: { description: "Fetch one candidate by id." } },
      host_list_records: { binding: "GET /api/jobs", fields: { description: "List open jobs." } },
    },
  });

  const CATALOG = JSON.stringify({
    tools: [
      { name: "host_get_record", description: "GET /api/candidates/{id}", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
      { name: "host_list_records", description: "GET /api/jobs", inputSchema: { type: "object", properties: {} } },
    ],
  });

  it("says which document it declined, and what would read it", () => {
    const found = discoverHostContracts(
      memoryRepoSource({ ".agent/tools.json": CATALOG, ".agent/judgments.json": NESTED }),
    );
    expect(found.contracts[0]?.sources).toEqual([".agent/tools.json"]);
    const note = found.notes.find((n) => n.where === ".agent/judgments.json");
    expect(note?.detail).toContain("--fields-at");
  });

  it("merges it once it is told where the fields are", () => {
    const found = discoverHostContracts(
      memoryRepoSource({ ".agent/tools.json": CATALOG, ".agent/judgments.json": NESTED }),
      { fieldsKey: "fields" },
    );
    expect(found.contracts).toHaveLength(1);
    expect(found.contracts[0]?.sources).toEqual([".agent/tools.json", ".agent/judgments.json"]);
    expect(found.notes).toEqual([]);
  });
});

describe("a spec is a contract too", () => {
  it("finds an OpenAPI document, since a generator hands its operations to a model", () => {
    const found = discoverHostContracts(
      memoryRepoSource({
        "openapi.json": JSON.stringify({
          openapi: "3.0.3",
          paths: {
            "/jobs": {
              get: {
                operationId: "list_jobs",
                summary: "List open jobs.",
                parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
              },
            },
          },
        }),
      }),
    );
    expect(found.contracts[0]?.catalog).toBe("openapi.json");
    expect(found.contracts[0]?.tools).toBe(1);
  });
});

describe("baselineSlug", () => {
  it("names a baseline after the file it snapshots", () => {
    expect(baselineSlug(".agent/tools.json")).toBe("agent-tools");
    expect(baselineSlug("src/agent/mcp.json")).toBe("src-agent-mcp");
  });
});
