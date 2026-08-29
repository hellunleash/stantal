import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { auditProject, auditVerdict, contractDependencies, heldByRange, isUnreachable } from "./audit.js";
import { RegistryError, type Registry } from "./registry/npm.js";
import { memoryRepoSource } from "./blast/repo.js";

/**
 * Offline throughout. The fake registry writes the files a real unpack would,
 * so the audit exercises the same extraction path as a published tarball.
 */
function registryOf(latest: Record<string, string>, files: Record<string, Record<string, string>>): Registry {
  return {
    async versions(name) {
      const version = latest[name];
      if (version === undefined) throw new RegistryError(`no such package ${name}`);
      return [{ version, publishedAt: "2026-01-01T00:00:00.000Z", deprecated: null }];
    },
    async manifest(name) {
      const version = latest[name];
      if (version === undefined) throw new RegistryError(`could not read the release history of ${name}`);
      return { version, dependencies: {} };
    },
    async extract(name, version, destination) {
      const contents = files[`${name}@${version}`];
      if (contents === undefined) throw new RegistryError(`no such version ${name}@${version}`);
      for (const [path, body] of Object.entries(contents)) {
        const full = join(destination, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body, "utf8");
      }
    },
  };
}

/** A pack whose `build` tool takes exactly these optional parameters. */
function pack(name: string, description: string, optional: readonly string[]): Record<string, string> {
  const properties = ['request: { type: "string" }', ...optional.map((p) => `${p}: { type: "string" }`)];
  return {
    "package.json": JSON.stringify({ name, version: "0.0.0", exports: { ".": "./pack.js" } }),
    "pack.js": `export const tools = [{
      name: "build",
      description: ${JSON.stringify(description)},
      inputSchema: { type: "object", properties: { ${properties.join(", ")} }, required: ["request"] },
    }];`,
  };
}

const PLAIN = "Build a screen from a request.";

/** A project directory with real files in node_modules, as a checkout would have. */
function project(deps: Record<string, { version: string; files: Record<string, string> }>): string {
  const root = mkdtempSync(join(tmpdir(), "stantal-audit-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "consumer",
      // The range a real consumer would have written for what they installed.
      // Layer 3 asks whether the declared range admits an affected version, so
      // a placeholder range here would filter every finding before the scan.
      dependencies: Object.fromEntries(Object.entries(deps).map(([name, dep]) => [name, `^${dep.version}`])),
    }),
    "utf8",
  );
  for (const [name, dep] of Object.entries(deps)) {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    for (const [path, body] of Object.entries(dep.files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(
        full,
        path === "package.json" ? JSON.stringify({ ...JSON.parse(body), version: dep.version }) : body,
        "utf8",
      );
    }
  }
  return root;
}

async function audit(root: string, registry: Registry, extra: Record<string, unknown> = {}) {
  return auditProject({
    directory: root,
    registry,
    judge: null,
    cacheRoot: mkdtempSync(join(tmpdir(), "stantal-audit-cache-")),
    ...extra,
  });
}

describe("contractDependencies", () => {
  test("names only the dependencies that hand a model tools", () => {
    const root = project({
      "@example/tools": { version: "1.0.0", files: pack("@example/tools", PLAIN, []) },
      "left-pad": {
        version: "1.0.0",
        files: { "package.json": JSON.stringify({ name: "left-pad", main: "./index.js" }), "index.js": "export const pad = 1;" },
      },
    });

    const found = contractDependencies(root);
    expect(found.map((d) => d.package)).toEqual(["@example/tools"]);
    expect(found[0]?.tools).toBe(1);
  });

  test("a project with no manifest is empty, not an error", () => {
    expect(contractDependencies(mkdtempSync(join(tmpdir(), "stantal-empty-")))).toEqual([]);
  });
});

describe("auditProject", () => {
  test("compares what is installed against what a fresh install would give", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", PLAIN, []) } });
    const registry = registryOf(
      { "@example/tools": "2.0.0" },
      {
        "@example/tools@1.0.0": pack("@example/tools", PLAIN, []),
        // The newer release offers a parameter with nothing explaining it.
        "@example/tools@2.0.0": pack("@example/tools", PLAIN, ["target"]),
      },
    );

    const result = await audit(root, registry);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.installed).toBe("1.0.0");
    expect(entry?.latest).toBe("2.0.0");
    expect(entry?.report?.verdict).toBe("prose-risk");
    expect(auditVerdict(result)).toBe("prose-risk");
  });

  test("says nothing is waiting when the installed version is the newest", async () => {
    const root = project({ "@example/tools": { version: "2.0.0", files: pack("@example/tools", PLAIN, []) } });
    const result = await audit(root, registryOf({ "@example/tools": "2.0.0" }, {}));

    const entry = result.entries[0];
    expect(entry?.report).toBeNull();
    expect(entry?.note).toBe("already on the newest release");
    // Nothing was left unread, so the audit is allowed to say clean.
    expect(isUnreachable(entry!)).toBe(false);
    expect(auditVerdict(result)).toBe("clean");
  });

  test("a dependency it could not reach is a gap, never a pass", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", PLAIN, []) } });
    // The registry knows nothing about this package, so `latest` cannot resolve.
    const result = await audit(root, registryOf({}, {}));

    const entry = result.entries[0];
    expect(entry?.report).toBeNull();
    expect(entry?.note).toContain("could not reach the registry");
    expect(isUnreachable(entry!)).toBe(true);
    // The one claim this must never make.
    expect(auditVerdict(result)).toBe("unreadable");
  });

  test("a project with nothing to check is distinguishable from a clean one", async () => {
    const root = project({});
    const result = await audit(root, registryOf({}, {}));
    expect(result.entries).toEqual([]);
    expect(auditVerdict(result)).toBe("nothing-to-check");
  });

  test("ranks worse verdicts first, and reach breaks the tie", async () => {
    const root = project({
      "@example/a": { version: "1.0.0", files: pack("@example/a", PLAIN, []) },
      "@example/b": { version: "1.0.0", files: pack("@example/b", PLAIN, []) },
    });
    const registry = registryOf(
      { "@example/a": "2.0.0", "@example/b": "2.0.0" },
      {
        "@example/a@1.0.0": pack("@example/a", PLAIN, []),
        // Unchanged: clean.
        "@example/a@2.0.0": pack("@example/a", PLAIN, []),
        "@example/b@1.0.0": pack("@example/b", PLAIN, []),
        // Gains an undocumented optional: prose-risk.
        "@example/b@2.0.0": pack("@example/b", PLAIN, ["target"]),
      },
    );

    const result = await audit(root, registry);
    expect(result.entries.map((e) => e.package)).toEqual(["@example/b", "@example/a"]);
  });

  test("reports which of the consumer's files a finding reaches", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", PLAIN, []) } });
    const registry = registryOf(
      { "@example/tools": "1.1.0" },
      {
        "@example/tools@1.0.0": pack("@example/tools", PLAIN, []),
        "@example/tools@1.1.0": pack("@example/tools", PLAIN, ["target"]),
      },
    );

    // A caret that is clean on the version installed today and admits the one
    // carrying the defect. Worth knowing before the next install, not after.
    const result = await audit(root, registry, {
      repo: memoryRepoSource({
        "package.json": JSON.stringify({ dependencies: { "@example/tools": "^1.0.0" } }),
        "src/agent.ts": 'import { tools } from "@example/tools";\nconst t = "build";\n',
      }),
    });

    const blast = result.entries[0]?.report?.blast;
    expect(blast).not.toBeNull();
    expect(blast!.reaches.length).toBeGreaterThan(0);
  });

  test("separates a range that already excludes the defect from one that reaches nothing", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", PLAIN, []) } });
    const registry = registryOf(
      { "@example/tools": "2.0.0" },
      {
        "@example/tools@1.0.0": pack("@example/tools", PLAIN, []),
        "@example/tools@2.0.0": pack("@example/tools", PLAIN, ["target"]),
      },
    );

    // A caret on 1.x cannot admit 2.0.0, so the finding is real and cannot
    // arrive until somebody widens this line. That is a different answer from
    // "nothing in your code touches it", and leads to different advice.
    const result = await audit(root, registry, {
      repo: memoryRepoSource({
        "package.json": JSON.stringify({ dependencies: { "@example/tools": "^1.0.0" } }),
        "src/agent.ts": 'import { tools } from "@example/tools";\nconst t = "build";\n',
      }),
    });

    const entry = result.entries[0]!;
    expect(entry.report?.verdict).toBe("prose-risk");
    expect(heldByRange(entry)).toBe(true);
    expect(entry.report?.blast?.filtered.every((f) => f.kind === "range_excludes")).toBe(true);
  });

  test("notices a dependency that is already pinned", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", PLAIN, []) } });
    // The name `pin` writes, for this package at its root subpath.
    mkdirSync(join(root, "stantal"), { recursive: true });
    writeFileSync(join(root, "stantal", "example-tools.root.contract.test.ts"), "// pinned", "utf8");

    const result = await audit(root, registryOf({ "@example/tools": "1.0.0" }, {}));
    expect(result.entries[0]?.pinnedSubpaths).toEqual(["."]);
  });
});
