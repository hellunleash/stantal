import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { extractFromModule } from "../extract/module.js";
import { DEFAULT_CACHE_ROOT, installPackage } from "./install.js";
import { RegistryError, type Registry, type ResolvedManifest, type VersionInfo } from "./npm.js";

/**
 * Offline throughout. The fake registry writes the same files a real unpack
 * would, so the install path, the cache and the extractor are all exercised
 * without a network call.
 */

type FakePackage = { files: Record<string, string> };

function fakeRegistry(packages: Record<string, FakePackage>) {
  const calls = { extract: [] as string[], manifest: [] as string[] };

  const registry: Registry = {
    async versions(name): Promise<VersionInfo[]> {
      return Object.keys(packages)
        .filter((key) => key.startsWith(`${name}@`))
        .map((key, index) => ({
          version: key.slice(name.length + 1),
          publishedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
          deprecated: null,
        }));
    },

    async manifest(name, spec): Promise<ResolvedManifest> {
      calls.manifest.push(`${name}@${spec}`);
      const exact = spec.replace(/^[\^~]/, "");
      const entry = packages[`${name}@${exact}`];
      if (entry === undefined) throw new RegistryError(`no such package ${name}@${spec}`);
      const manifest = JSON.parse(entry.files["package.json"] ?? "{}") as {
        dependencies?: Record<string, string>;
      };
      return { version: exact, dependencies: manifest.dependencies ?? {} };
    },

    async extract(name, version, destination): Promise<void> {
      calls.extract.push(`${name}@${version}`);
      const entry = packages[`${name}@${version}`];
      if (entry === undefined) throw new RegistryError(`no such package ${name}@${version}`);
      for (const [path, contents] of Object.entries(entry.files)) {
        const full = join(destination, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, contents, "utf8");
      }
    },
  };

  return { registry, calls };
}

const roots: string[] = [];
function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stantal-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  roots.length = 0;
});

const TOOLS_PACKAGE: FakePackage = {
  files: {
    "package.json": JSON.stringify({
      name: "@example/tools",
      version: "2.0.0",
      exports: { "./pack": "./dist/pack.js" },
      dependencies: { "@example/core": "^1.0.0" },
    }),
    "dist/pack.js": `
      import { BUILD_TOOL } from "@example/core";
      export const tools = [{
        name: BUILD_TOOL,
        description: "Build a screen.",
        inputSchema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
      }];
    `,
  },
};

const CORE_PACKAGE: FakePackage = {
  files: {
    "package.json": JSON.stringify({ name: "@example/core", version: "1.0.0", exports: { ".": "./index.js" } }),
    "index.js": `export const BUILD_TOOL = "build";`,
  },
};

describe("installPackage", () => {
  test("unpacks a version and its direct dependencies", async () => {
    const { registry, calls } = fakeRegistry({
      "@example/tools@2.0.0": TOOLS_PACKAGE,
      "@example/core@1.0.0": CORE_PACKAGE,
    });

    const installed = await installPackage("@example/tools", "2.0.0", { registry, root: cacheRoot() });

    expect(calls.extract.sort()).toEqual(["@example/core@1.0.0", "@example/tools@2.0.0"]);
    expect(installed.missing).toEqual([]);
    expect(readdirSync(installed.directory)).toContain("package.json");
  });

  test("the extractor can name a tool once the dependency is on disk", async () => {
    const { registry } = fakeRegistry({
      "@example/tools@2.0.0": TOOLS_PACKAGE,
      "@example/core@1.0.0": CORE_PACKAGE,
    });
    const installed = await installPackage("@example/tools", "2.0.0", { registry, root: cacheRoot() });

    const result = extractFromModule({
      package: "@example/tools",
      version: "2.0.0",
      subpath: "./pack",
      source: installed.source,
    });

    if (!result.present) throw new Error(`expected a contract, got ${result.absence.reason}`);
    // This is the whole reason dependencies are fetched: the tool's name lives
    // in a sibling package, and without it the descriptor cannot be named.
    expect(result.contract.tools.map((t) => t.name)).toEqual(["build"]);
    expect(result.fidelity).toBe("complete");
  });

  test("a dependency it cannot fetch is recorded, not fatal", async () => {
    const { registry } = fakeRegistry({ "@example/tools@2.0.0": TOOLS_PACKAGE });
    const installed = await installPackage("@example/tools", "2.0.0", { registry, root: cacheRoot() });

    expect(installed.missing).toEqual(["@example/core@^1.0.0"]);

    const result = extractFromModule({
      package: "@example/tools",
      version: "2.0.0",
      subpath: "./pack",
      source: installed.source,
    });
    // Degrades exactly as far as the gap goes: the descriptor is seen, its name
    // is not read, and that is reported rather than guessed.
    expect(result).toMatchObject({ present: false, absence: { reason: "descriptors_unreadable" } });
  });

  test("does not fetch a version twice", async () => {
    const { registry, calls } = fakeRegistry({
      "@example/tools@2.0.0": TOOLS_PACKAGE,
      "@example/core@1.0.0": CORE_PACKAGE,
    });
    const root = cacheRoot();

    await installPackage("@example/tools", "2.0.0", { registry, root });
    await installPackage("@example/tools", "2.0.0", { registry, root });

    // A published version is immutable, so the cache is permanent. This is what
    // makes reading a whole release history a one-time cost.
    expect(calls.extract).toEqual(["@example/tools@2.0.0", "@example/core@1.0.0"]);
  });

  test("stops at the requested dependency depth", async () => {
    const { registry, calls } = fakeRegistry({
      "@example/tools@2.0.0": TOOLS_PACKAGE,
      "@example/core@1.0.0": CORE_PACKAGE,
    });

    await installPackage("@example/tools", "2.0.0", { registry, root: cacheRoot(), depth: 0 });
    expect(calls.extract).toEqual(["@example/tools@2.0.0"]);
  });

  test("refuses a spec that is not an exact registry version", async () => {
    const { registry } = fakeRegistry({});
    // A git or file spec would make a real fetcher run the package's `prepare`
    // script. Nothing in this project ever executes an extracted package.
    await expect(installPackage("@example/tools", "^2.0.0", { registry, root: cacheRoot() })).rejects.toThrow(
      /exact version is required/,
    );
    await expect(
      installPackage("github:someone/repo", "2.0.0", { registry, root: cacheRoot() }),
    ).rejects.toThrow(/plain registry package name/);
  });
});

describe("the cache does not become the user's problem", () => {
  test("defaults outside the project", () => {
    // It holds other people's code, unpacked. Inside a repository it reached
    // 60MB on a real install, nothing ignored it, and the packages' own test
    // files got collected by a bare `vitest run` — 153 files instead of 7.
    expect(DEFAULT_CACHE_ROOT).not.toBe(".stantal/npm");
    expect(isAbsolute(DEFAULT_CACHE_ROOT)).toBe(true);
    expect(DEFAULT_CACHE_ROOT.replace(/\\/g, "/")).toContain("stantal/npm");
  });

  test("ignores itself wherever it is put", async () => {
    // `--cache` can still point it inside a repository, and existing installs
    // already have one there. The failure mode is committing 60MB of somebody
    // else's source, so the guard travels with the directory.
    const root = cacheRoot();
    const { registry } = fakeRegistry({ "@example/tools@2.0.0": TOOLS_PACKAGE });
    await installPackage("@example/tools", "2.0.0", { registry, root, depth: 0 });

    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    // `*` covers the .gitignore too, so the directory leaves no trace at all.
    expect(ignore).toContain("*");
  });

  test("never overwrites one the user has edited", async () => {
    const root = cacheRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "# mine\n", "utf8");

    const { registry } = fakeRegistry({ "@example/tools@2.0.0": TOOLS_PACKAGE });
    await installPackage("@example/tools", "2.0.0", { registry, root, depth: 0 });

    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("# mine\n");
  });
});
