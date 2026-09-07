import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsJsonSource } from "../blast/repo.js";
import { discoverHostContracts } from "./discover.js";
import { baselineWouldBeIgnored, loadBaseline, saveBaseline } from "./baseline.js";
import { saveSnapshots, snapshotHostContracts } from "./snapshot.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stantal-host-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, "utf8");
}

function skeleton(withId: boolean): string {
  return JSON.stringify({
    tools: [
      {
        name: "host_get_record",
        description: "GET /api/candidates/{id}",
        inputSchema: {
          type: "object",
          properties: withId ? { id: { type: "string" } } : {},
          ...(withId ? { required: ["id"] } : {}),
        },
      },
    ],
  });
}

function judgments(guidance: string): string {
  return JSON.stringify({ tools: { host_get_record: { description: guidance } } });
}

const FULL = "Fetch one candidate by id. Pass the candidate's id, not their email.";

function repo() {
  return fsJsonSource(root);
}

async function run() {
  return snapshotHostContracts({ root, repo: repo() });
}

function saveAll(): void {
  saveSnapshots(root, repo(), discoverHostContracts(repo()).contracts);
}

describe("a generated contract, twice", () => {
  it("says there is nothing to compare against before a baseline exists", () => {
    write(".agent/tools.json", skeleton(true));
    return run().then((result) => {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.baseline).toBeNull();
      // Null, never an empty contract. "Nothing saved yet" and "every tool was
      // removed" are opposite claims.
      expect(result.entries[0]?.report).toBeNull();
      expect(result.entries[0]?.note).toContain("no baseline");
    });
  });

  it("is clean when the regenerated file says the same thing", async () => {
    write(".agent/tools.json", skeleton(true));
    saveAll();
    const result = await run();
    expect(result.entries[0]?.report?.verdict).toBe("clean");
  });

  it("catches a regeneration that drops a parameter and a sentence", async () => {
    // The case this exists for. Two runs of the host's own generator, hours
    // apart, on code nothing else here can version: semver, the type-checker
    // and the test suite all see an unchanged repository.
    write(".agent/tools.json", skeleton(true));
    write(".agent/judgments.json", judgments(FULL));
    saveAll();

    write(".agent/tools.json", skeleton(false));
    write(".agent/judgments.json", judgments("Fetch one candidate by id."));

    const result = await run();
    const surface = result.entries[0]?.report?.surfaces[0];
    expect(surface?.comparison.diff?.changes.map((c) => `${c.rule} ${c.target}`)).toContain(
      "param_removed host_get_record.id",
    );
    expect(surface?.prose.findings.map((f) => f.rule)).toContain("guidance_removed");
  });

  it("reads the merge, not the first file", async () => {
    // Reading `tools.json` alone over-reported prose findings 2x and missed 7
    // removed tools on a real host, because its descriptions are route strings
    // and the prose a model receives lives in the second document.
    write(".agent/tools.json", skeleton(true));
    write(".agent/judgments.json", judgments(FULL));
    saveAll();

    const stored = loadBaseline(root, ".agent/tools.json");
    expect(stored?.sources).toHaveLength(2);

    const result = await run();
    const to = result.entries[0]?.report?.surfaces[0]?.to;
    expect(to?.present === true ? to.contract.tools[0]?.description : null).toBe(FULL);
  });
});

describe("a watched contract keeps its identity", () => {
  it("survives the regeneration that empties every schema", async () => {
    // The field case: 50 tools, 2 input schemas. The document that carried the
    // parameters no longer does, so a fresh guess at which file is the catalog
    // flips to the other one — and the baseline, stored under the first name,
    // would look like it was never saved. That is the run with the most to say.
    write(".agent/judgments.json", judgments(FULL));
    write(".agent/tools.json", skeleton(true));
    saveAll();

    write(".agent/tools.json", skeleton(false));
    const result = await run();

    expect(result.entries[0]?.contract.catalog).toBe(".agent/tools.json");
    expect(result.entries[0]?.baseline).not.toBeNull();
    expect(result.entries[0]?.report?.verdict).not.toBe("clean");
  });

  it("saves under the name it already has, never a second one", async () => {
    write(".agent/judgments.json", judgments(FULL));
    write(".agent/tools.json", skeleton(true));
    saveAll();

    write(".agent/tools.json", skeleton(false));
    saveAll();

    expect(readdirSync(join(root, ".stantal/contracts"))).toEqual(["agent-tools"]);
  });
});

describe("the baseline itself", () => {
  it("stores each document as a file, so the diff is readable", () => {
    write(".agent/tools.json", skeleton(true));
    write(".agent/judgments.json", judgments(FULL));
    saveAll();

    const stored = readFileSync(join(root, ".stantal/contracts/agent-tools/1-judgments.json"), "utf8");
    expect(JSON.parse(stored)).toEqual(JSON.parse(judgments(FULL)));
  });

  it("drops a document that is no longer part of the contract", () => {
    write(".agent/tools.json", skeleton(true));
    write(".agent/judgments.json", judgments(FULL));
    saveAll();

    rmSync(join(root, ".agent/judgments.json"));
    saveAll();

    // A stale half left behind would be read back in on the next load and
    // reported as prose the working tree had deleted.
    expect(loadBaseline(root, ".agent/tools.json")?.sources).toHaveLength(1);
  });

  it("refuses to overwrite a baseline belonging to a different contract", () => {
    write(".agent/tools.json", skeleton(true));
    saveAll();

    expect(() =>
      saveBaseline(
        root,
        { catalog: "agent/tools.json", sources: ["agent/tools.json"], tools: 1, withParams: 1, why: "" },
        () => skeleton(true),
      ),
    ).toThrow(/already holds a baseline/);
  });

  it("treats a half-missing baseline as broken, not as an empty contract", async () => {
    write(".agent/tools.json", skeleton(true));
    write(".agent/judgments.json", judgments(FULL));
    saveAll();
    rmSync(join(root, ".stantal/contracts/agent-tools/1-judgments.json"));

    const result = await run();
    expect(result.entries[0]?.report).toBeNull();
    expect(result.entries[0]?.note).toContain("unreadable");
  });
});

describe("a baseline nobody commits", () => {
  it("says so when the whole of .stantal is ignored", () => {
    // Silent otherwise: the comparison works on the machine that saved it and
    // nowhere else, which turns a shared check into a personal one. This
    // project's own .gitignore carries that rule for an unrelated reason, so
    // somebody will copy it.
    write(".gitignore", "node_modules\n.stantal/\n");
    expect(baselineWouldBeIgnored(root)).toBe(true);
  });

  it("is quiet when only the cache is ignored", () => {
    write(".gitignore", "node_modules\n.stantal/npm/\n");
    expect(baselineWouldBeIgnored(root)).toBe(false);
  });
});
