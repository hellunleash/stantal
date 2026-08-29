import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyReplay, main, warnIfGeminiBillsACard } from "./cli.js";

/**
 * The CLI's flag plumbing, tested where it can be tested without a network.
 *
 * Everything here stops before `buildReport` — a refusal, a validation error,
 * or a pure function. The layers themselves are covered by their own suites;
 * what is worth pinning at this level is the promises the flags make, because
 * those are made in prose in `USAGE` and kept in code somewhere else.
 */

let stderr: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  stderr = "";
  saved = { ...process.env };
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  // `main` calls `loadDotEnv`, which mutates the real environment. Without this
  // a machine with a `.env` and one without would run different tests.
  process.env = saved;
  vi.restoreAllMocks();
});

describe("applyReplay", () => {
  it("silences every layer that can call out, not just the judge", () => {
    // The flag says the run cannot spend. When Layer 2 arrived, setting only
    // the judge's cache would have left that promise false while still being
    // printed in --help.
    const env: NodeJS.ProcessEnv = {};
    applyReplay(env);
    expect(env["STANTAL_JUDGE_CACHE"]).toBe("replay");
    expect(env["STANTAL_BEHAVIOUR_CACHE"]).toBe("replay");
  });
});

describe("--behaviour", () => {
  it("is refused on a history walk rather than quietly ignored", async () => {
    // A walk runs the pair logic once per release, so Layer 2 there is k calls
    // per request per side times every version in the range. Ignoring the flag
    // would be safe; accepting it would be very expensive. Saying so is better
    // than either.
    const code = await main(["history", "example", "--behaviour"]);
    expect(code).toBe(2);
    expect(stderr).toContain("not available on a history walk");
  });

  it("warns and carries on when no key is set, rather than failing", async () => {
    process.env["STANTAL_CALLER"] = "none";
    // One positional and no versions, so this returns on usage before touching
    // the network. The point is only that asking for Layer 2 without a key is
    // not fatal here.
    const code = await main(["example", "--behaviour"]);
    expect(code).toBe(2);
    expect(stderr).toContain("stantal —");
  });
});

describe("--k", () => {
  it("refuses a value that is not a positive whole number", async () => {
    process.env["STANTAL_CALLER"] = "openai";
    process.env["OPENAI_API_KEY"] = "test-key-never-used";
    const code = await main(["example", "1.0.0", "2.0.0", "--behaviour", "--k", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--k must be a positive whole number");
  });
});

describe("--k validation", () => {
  it("warns rather than silently dropping it when --behaviour is absent", async () => {
    // Parsed on every path, so the same argument means the same thing whether
    // or not a key happens to be present.
    // One positional and no versions, so this stops at usage without touching
    // the network. The warning still has to have been printed by then, which is
    // the point: an argument is judged before any work is done on its behalf.
    const code = await main(["example", "--k", "8"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--k only applies with --behaviour");
  });

  it("rejects a value parseInt would silently truncate", async () => {
    // `parseInt("1e3")` is 1, which would hand the weakest possible sample to
    // someone asking for the strongest.
    const code = await main(["--k", "1e3"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--k must be a positive whole number");
  });
});

describe("manifest", () => {
  /**
   * The one CLI path that can be exercised whole in a unit test.
   *
   * Nothing is fetched and no version is resolved, so `buildManifestReport`
   * runs here for real rather than being stubbed. That is a property of the
   * feature, not of the test: a provider comparing two files they already have
   * is offline by construction.
   */
  let dir: string;
  let stdout: string;

  const BEFORE = {
    tools: [
      {
        name: "create_item",
        description: "POST /api/item",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "The item id." } },
          required: ["id"],
        },
      },
    ],
  };

  const AFTER = {
    tools: [
      {
        name: "create_item",
        description: "POST /api/item",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
      },
    ],
  };

  function write(name: string, body: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  }

  beforeEach(() => {
    stdout = "";
    dir = mkdtempSync(join(tmpdir(), "stantal-manifest-"));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("compares two files with no network and no key", async () => {
    const code = await main([
      "manifest",
      write("before.json", BEFORE),
      write("after.json", AFTER),
      "--no-judge",
      "--json",
    ]);

    expect(code).toBe(1);
    const report = JSON.parse(stdout) as {
      verdict: string;
      subject: { ecosystem: string; package: string };
      judge: string;
      caller: string;
      surfaces: Array<{ comparison: { diff: { changes: Array<{ rule: string; target: string }> } } }>;
    };

    expect(report.verdict).toBe("structurally-breaking");
    expect(report.subject.ecosystem).toBe("http");
    // No model was consulted on either layer, and the report says so rather
    // than naming one that was configured but never called.
    expect(report.judge).toBe("none");
    expect(report.caller).toBe("none");

    const rules = report.surfaces[0]!.comparison.diff.changes.map((c) => `${c.rule} ${c.target}`);
    expect(rules).toContain("param_removed create_item.id");
    expect(rules).toContain("param_added_optional create_item.title");
  });

  it("names the subject after the file unless told otherwise", async () => {
    await main(["manifest", write("a.json", BEFORE), write("b.json", BEFORE), "--no-judge", "--json"]);
    expect((JSON.parse(stdout) as { subject: { package: string } }).subject.package).toBe("b.json");

    stdout = "";
    await main([
      "manifest",
      write("a.json", BEFORE),
      write("b.json", BEFORE),
      "--no-judge",
      "--json",
      "--name",
      "acme-host",
    ]);
    expect((JSON.parse(stdout) as { subject: { package: string } }).subject.package).toBe("acme-host");
  });

  it("exits 2 on a file it cannot read, never a verdict", async () => {
    // A file we could not open is a gap in the reading. Reporting "clean"
    // because nothing was compared is the failure mode the exit codes exist to
    // prevent.
    const code = await main(["manifest", write("a.json", BEFORE), join(dir, "missing.json"), "--no-judge"]);
    expect(code).toBe(2);
    expect(stderr).toContain("cannot read");
  });

  it("exits 2 when only one side is given", async () => {
    const code = await main(["manifest", write("a.json", BEFORE), "--no-judge"]);
    expect(code).toBe(2);
    expect(stderr).toContain("needs two files");
  });

  it("reports an unreadable file as unreadable, not as an empty contract", async () => {
    // The invariant the extractor is built around, checked at the surface a
    // user actually touches: a file we cannot parse must not compare as a
    // contract with no tools, which would read as "every tool was removed".
    const code = await main([
      "manifest",
      write("a.json", BEFORE),
      write("b.json", "{ not json"),
      "--no-judge",
      "--json",
    ]);
    expect(code).toBe(2);
    expect((JSON.parse(stdout) as { verdict: string }).verdict).toBe("unreadable");
  });
});

describe("warnIfGeminiBillsACard", () => {
  /**
   * The two gemini endpoints serve the same models and bill to different
   * places, and only one of them draws on cloud credits. Nothing in a run's
   * output says which door it went through, so an unset project spends real
   * money while credits sit unused.
   */
  function warn(id: string | undefined, env: NodeJS.ProcessEnv): string {
    let out = "";
    warnIfGeminiBillsACard(id, env, (s) => { out += s; });
    return out;
  }

  it("warns when gemini runs without a Vertex project", () => {
    expect(warn("gemini:gemini-3.6-flash", {})).toContain("STANTAL_VERTEX_PROJECT");
  });

  it("stays quiet once the run is routed through Vertex", () => {
    expect(warn("gemini:gemini-3.6-flash", { STANTAL_VERTEX_PROJECT: "proj" })).toBe("");
  });

  it("says nothing about the other providers, whose billing this does not touch", () => {
    expect(warn("openai:gpt-5.4", {})).toBe("");
    expect(warn("anthropic:claude-opus-5", {})).toBe("");
  });

  it("says nothing when no model is configured at all", () => {
    expect(warn(undefined, {})).toBe("");
  });
});

describe("manifest with a split contract", () => {
  let dir: string;
  let stdout: string;

  const CATALOG = {
    tools: [
      { name: "remove_member", description: "DELETE /api/member/{id}",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      { name: "internal_hook", description: "POST /api/hook" },
    ],
  };

  // Keyed by name, fields nested, and carrying policy the host applies but the
  // document only states. All three shapes appear together in a real host dump.
  const PROSE = {
    tools: {
      remove_member: { fields: { description: "Removes one member. Owner-only.", audience: "end-user" } },
      internal_hook: { fields: { description: "Webhook receiver.", audience: "internal" } },
    },
  };

  function write(name: string, body: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  beforeEach(() => {
    stdout = "";
    dir = mkdtempSync(join(tmpdir(), "stantal-split-"));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges the documents a side names, and applies the caller's policy", async () => {
    const before = write("before.json", CATALOG);
    const code = await main([
      "manifest",
      before,
      `${write("after.json", CATALOG)},${write("prose.json", PROSE)}`,
      "--fields-at",
      "fields",
      "--exclude-when",
      "audience=internal",
      "--no-judge",
      "--json",
    ]);

    expect(code).toBe(1);
    const report = JSON.parse(stdout) as {
      surfaces: Array<{ to: { contract: { tools: Array<{ name: string; description: string }> } } }>;
    };
    const tools = report.surfaces[0]!.to.contract.tools;

    // The prose reached the contract, the schema survived it, and the tool the
    // host withholds is not in what a model would receive.
    expect(tools.map((t) => t.name)).toEqual(["remove_member"]);
    expect(tools[0]!.description).toBe("Removes one member. Owner-only.");
  });

  it("refuses a malformed --exclude-when rather than ignoring it", async () => {
    const code = await main([
      "manifest",
      write("a.json", CATALOG),
      write("b.json", CATALOG),
      "--exclude-when",
      "audience",
      "--no-judge",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("wants key=value");
  });

  it("names the missing document when one side lists a file that is not there", async () => {
    const code = await main([
      "manifest",
      write("a.json", CATALOG),
      `${write("b.json", CATALOG)},${join(dir, "absent.json")}`,
      "--no-judge",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("absent.json");
  });
});

describe("--repo (Layer 3)", () => {
  let dir: string;
  let stdout: string;

  const CATALOG = {
    tools: [
      { name: "remove_member", description: "DELETE /api/member/{id}",
        inputSchema: { type: "object", properties: { id: { type: "string" }, role: { type: "string" } }, required: ["id"] } },
    ],
  };
  const NARROWED = {
    tools: [
      { name: "remove_member", description: "DELETE /api/member/{id}",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    ],
  };

  function write(name: string, body: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  }

  beforeEach(() => {
    stdout = "";
    dir = mkdtempSync(join(tmpdir(), "stantal-repo-"));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the working directory by default", async () => {
    // On by default. The caution belongs on sending something out, not on
    // reading something in -- and the Action has defaulted this to "." since it
    // shipped, so the old default left the path a person types answering a
    // weaker question than the path CI runs.
    await main(["manifest", write("a.json", CATALOG), write("b.json", NARROWED), "--no-judge", "--json"]);
    expect((JSON.parse(stdout) as { blast: unknown }).blast).not.toBeNull();
  });

  it("reads nothing when told none", async () => {
    // The escape hatch, on the same sentinel the Action already uses. A null
    // blast means nobody looked, which is a claim that has to stay reachable.
    await main([
      "manifest",
      write("a.json", CATALOG),
      write("b.json", NARROWED),
      "--repo",
      "none",
      "--no-judge",
      "--json",
    ]);
    expect((JSON.parse(stdout) as { blast: unknown }).blast).toBeNull();
  });

  it("reports which of the consumer's files a finding reaches", async () => {
    const repo = mkdtempSync(join(tmpdir(), "stantal-consumer-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { "b.json": "^1.0.0" } }));
    writeFileSync(join(repo, "use.ts"), 'export const x = remove_member({ id: "1", role: "admin" });\n');

    try {
      await main([
        "manifest",
        write("a.json", CATALOG),
        write("b.json", NARROWED),
        "--no-judge",
        "--json",
        "--repo",
        repo,
      ]);

      const blast = (JSON.parse(stdout) as { blast: { reaches: Array<{ kind: string; evidence: string }> } }).blast;
      // `role` was removed from the schema, and the consumer still passes it.
      expect(blast.reaches.some((r) => r.kind === "tool_reference" && r.evidence.startsWith("use.ts"))).toBe(true);
      expect(blast.reaches.some((r) => r.kind === "param_reference")).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("pin --all", () => {
  let root: string;
  let stdout: string;
  let stderr: string;
  let cwd: string;

  const PACK = `export const tools = [{
    name: "build",
    description: "Build a screen from a request.",
    inputSchema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
  }];`;

  function installed(name: string, version: string): void {
    const dir = join(root, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, exports: { ".": "./pack.js" } }));
    writeFileSync(join(dir, "pack.js"), PACK);
  }

  beforeEach(() => {
    stdout = "";
    stderr = "";
    cwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), "stantal-pinall-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", dependencies: { "@example/tools": "^1.0.0", "left-pad": "^1.0.0" } }),
    );
    installed("@example/tools", "1.0.0");
    // A dependency that hands a model nothing, so it must not be pinned.
    const plain = join(root, "node_modules", "left-pad");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0", main: "./index.js" }));
    writeFileSync(join(plain, "index.js"), "export const pad = 1;");

    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("pins every contract-bearing dependency and leaves the rest alone", async () => {
    const code = await main(["pin", "--all", "--directory", root]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "stantal", "example-tools.root.contract.test.ts"))).toBe(true);
    expect(existsSync(join(root, "stantal", "left-pad.root.contract.test.ts"))).toBe(false);
  });

  it("writes into the directory it was pointed at, not the working directory", async () => {
    // Scanning one root and writing into another would put a suite about one
    // project inside a different one, and nothing downstream would notice.
    await main(["pin", "--all", "--directory", root]);
    expect(existsSync(join(process.cwd(), "stantal", "example-tools.root.contract.test.ts"))).toBe(false);
  });

  it("never overwrites a suite that already exists", async () => {
    mkdirSync(join(root, "stantal"), { recursive: true });
    const path = join(root, "stantal", "example-tools.root.contract.test.ts");
    writeFileSync(path, "// pinned by hand at an older version", "utf8");

    const code = await main(["pin", "--all", "--directory", root]);
    expect(code).toBe(0);
    // Re-recording against what is installed now would erase the assertions
    // that were about to fail, and report it as success.
    expect(readFileSync(path, "utf8")).toBe("// pinned by hand at an older version");
    expect(stdout).toContain("already pinned, left alone");
    // "0 of 2 pinned" was what this said, which reads as a failure and is the
    // opposite of what happened.
    expect(stdout).not.toContain("0 of");
  });

  it("refuses a package name and --all together", async () => {
    const code = await main(["pin", "@example/tools", "--all", "--directory", root]);
    expect(code).toBe(2);
    expect(stderr).toContain("a package name or --all, not both");
  });

  it("says so, and exits clean, when nothing here hands a model tools", async () => {
    const bare = mkdtempSync(join(tmpdir(), "stantal-bare-"));
    writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "empty" }));
    try {
      const code = await main(["pin", "--all", "--directory", bare]);
      expect(code).toBe(0);
      expect(stderr).toContain("no installed dependency");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("the no-argument command", () => {
  let root: string;
  let stdout: string;

  beforeEach(() => {
    stdout = "";
    root = mkdtempSync(join(tmpdir(), "stantal-audit-cli-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer" }));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs the audit instead of printing usage", async () => {
    const code = await main(["--directory", root, "--no-judge"]);
    // Nothing here to check is a clean exit, not a failure. A non-zero exit
    // would teach people to stop running this in CI.
    expect(code).toBe(0);
    expect(stdout).toContain("Nothing here can be affected by contract drift");
  });

  it("still prints usage when a package was named without versions", async () => {
    const code = await main(["@example/tools"]);
    expect(code).toBe(2);
  });
});
