import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { branchFor, watchProject, watchSummary } from "./watch.js";
import { RegistryError, type Registry } from "./registry/npm.js";
import { fsRepoSource, memoryRepoSource } from "./blast/repo.js";

/** Offline. The fake registry writes the files a real unpack would. */
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

function pack(name: string, optional: readonly string[]): Record<string, string> {
  const properties = ['request: { type: "string" }', ...optional.map((p) => `${p}: { type: "string" }`)];
  return {
    "package.json": JSON.stringify({ name, version: "0.0.0", exports: { ".": "./pack.js" } }),
    "pack.js": `export const tools = [{
      name: "build",
      description: "Build a screen from a request.",
      inputSchema: { type: "object", properties: { ${properties.join(", ")} }, required: ["request"] },
    }];`,
  };
}

/** A checkout with the package installed and a range that admits the upgrade. */
function project(version: string, range = "*"): string {
  const root = mkdtempSync(join(tmpdir(), "stantal-watch-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", dependencies: { "@example/tools": range } }),
    "utf8",
  );
  const dir = join(root, "node_modules", "@example", "tools");
  mkdirSync(dir, { recursive: true });
  for (const [path, body] of Object.entries(pack("@example/tools", []))) {
    writeFileSync(
      join(dir, path),
      path === "package.json" ? JSON.stringify({ ...JSON.parse(body), version }) : body,
      "utf8",
    );
  }
  return root;
}

const DRIFTED = registryOf(
  { "@example/tools": "2.0.0" },
  {
    "@example/tools@1.0.0": pack("@example/tools", []),
    // Gains a parameter with nothing explaining when to pass it.
    "@example/tools@2.0.0": pack("@example/tools", ["target"]),
  },
);

async function watch(root: string, registry: Registry, extra: Record<string, unknown> = {}) {
  return watchProject({
    directory: root,
    registry,
    judge: null,
    cacheRoot: mkdtempSync(join(tmpdir(), "stantal-watch-cache-")),
    ...extra,
  });
}

describe("watchProject", () => {
  test("warns when an upgrade changes what a model reads", async () => {
    const plan = await watch(project("1.0.0"), DRIFTED);

    expect(plan.action).toBe("warn");
    expect(plan.title).toContain("@example/tools 1.0.0 → 2.0.0");
    expect(plan.packages).toEqual(["@example/tools"]);
    expect(plan.body).toContain("prose-risk");
    // The reader has to be able to check it without believing us.
    expect(plan.body).toContain("npx stantal @example/tools 1.0.0 2.0.0");
  });

  test("stays quiet when the declared range cannot admit the affected version", async () => {
    // The finding is real and nothing changes until somebody widens that line.
    // A bot that files a pull request about it every week is a bot that gets
    // turned off, and then it is not there for the one that matters.
    const root = project("1.0.0", "^1.0.0");
    const plan = await watch(root, DRIFTED, { repo: fsRepoSource(root) });

    expect(plan.action).toBe("guard");
    expect(plan.title).toContain("Pin the tool contracts");
    expect(plan.comment).toBe("");
  });

  test("warns anyway when nobody scanned for a range", async () => {
    // Without a Layer 3 read there is no evidence the consumer is safe, and
    // silence about something we did not check is the one failure a watcher
    // must not have. Same finding as above, no repo: it speaks.
    const plan = await watch(project("1.0.0", "^1.0.0"), DRIFTED);
    expect(plan.action).toBe("warn");
  });

  test("says nothing when everything is current and pinned", async () => {
    const root = project("2.0.0");
    mkdirSync(join(root, "stantal"), { recursive: true });
    writeFileSync(join(root, "stantal", "example-tools.root.contract.test.ts"), "// pinned", "utf8");

    const plan = await watch(root, registryOf({ "@example/tools": "2.0.0" }, {}));

    expect(plan.action).toBe("nothing");
    expect(plan.title).toBe("");
    expect(plan.body).toBe("");
    expect(plan.tests).toEqual([]);
    expect(watchSummary(plan)).toContain("nothing waiting");
  });

  test("decides without writing unless asked", async () => {
    const root = project("1.0.0");
    const plan = await watch(root, DRIFTED);

    expect(plan.tests.length).toBeGreaterThan(0);
    // A watcher that wrote on the way to deciding would leave files behind on
    // every quiet night.
    expect(existsSync(join(root, "stantal", "example-tools.root.contract.test.ts"))).toBe(false);
  });

  test("writes the guard pinned to the installed version, not the newer one", async () => {
    const root = project("1.0.0");
    await watch(root, DRIFTED, { write: true });

    const path = join(root, "stantal", "example-tools.root.contract.test.ts");
    expect(existsSync(path)).toBe(true);
    // Taken from 1.0.0, which is what makes it fail when 2.0.0 lands. Recorded
    // from the newer side it would describe the defect and pass on it.
    const body = readFileSync(path, "utf8");
    expect(body).toContain("@example/tools@1.0.0");
  });

  test("reports test paths repo-relative, with forward slashes", async () => {
    const plan = await watch(project("1.0.0"), DRIFTED);

    // These go into a pull request body other people read. An absolute path is
    // meaningless to them and publishes the layout of whatever machine the
    // runner happened to be.
    expect(plan.tests[0]?.path).toBe("stantal/example-tools.root.contract.test.ts");
    expect(plan.body).not.toContain(tmpdir());
  });

  test("names a dependency it could not read, rather than passing over it", async () => {
    const plan = await watch(project("1.0.0"), registryOf({}, {}));

    expect(plan.unreadable).toEqual(["@example/tools"]);
    expect(plan.body).toContain("Not checked");
  });

  test("carries the reach into the pull request body", async () => {
    const plan = await watch(project("1.0.0"), DRIFTED, {
      repo: memoryRepoSource({
        "package.json": JSON.stringify({ dependencies: { "@example/tools": "*" } }),
        "src/agent.ts": 'import { tools } from "@example/tools";\nconst t = "build";\n',
      }),
    });

    expect(plan.body).toContain("Reaches this repository");
    expect(plan.body).toContain("src/agent.ts");
  });
});

describe("branchFor", () => {
  test("is the same on every run about the same finding", () => {
    const subject = {
      package: "@example/tools",
      installed: "1.0.0",
      latest: "2.0.0",
      verdict: "prose-risk",
      headline: "",
      reaches: [],
      heldByRange: false,
      unpinnedSubpaths: ["."],
    };
    // Keyed on the finding, never on the date. A branch named after today files
    // a fresh pull request every night for one unchanged finding.
    expect(branchFor("warn", [subject])).toBe(branchFor("warn", [subject]));
    expect(branchFor("warn", [subject])).toContain("example-tools-2-0-0");
  });

  test("does not change when the subjects arrive in a different order", () => {
    const a = {
      package: "@example/a",
      installed: "1.0.0",
      latest: "2.0.0",
      verdict: "prose-risk",
      headline: "",
      reaches: [],
      heldByRange: false,
      unpinnedSubpaths: [],
    };
    const b = { ...a, package: "@example/b" };
    expect(branchFor("warn", [a, b])).toBe(branchFor("warn", [b, a]));
  });
});
