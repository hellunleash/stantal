import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RegistryError, type Registry } from "./registry/npm.js";
import { buildReport, exitCodeFor } from "./report.js";

/** Offline: the fake registry writes the files a real unpack would. */
function registryOf(packages: Record<string, Record<string, string>>): Registry {
  return {
    async versions() {
      return [];
    },
    async manifest(name, spec) {
      const exact = spec.replace(/^[\^~]/, "");
      if (packages[`${name}@${exact}`] === undefined) throw new RegistryError(`no ${name}@${spec}`);
      return { version: exact, dependencies: {} };
    },
    async extract(name, version, destination) {
      const files = packages[`${name}@${version}`];
      if (files === undefined) throw new RegistryError(`no ${name}@${version}`);
      for (const [path, contents] of Object.entries(files)) {
        const full = join(destination, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, contents, "utf8");
      }
    },
  };
}

function cacheRoot(): string {
  return mkdtempSync(join(tmpdir(), "stantal-report-"));
}

const manifest = (exports: Record<string, string>) =>
  JSON.stringify({ name: "@example/tools", version: "0.0.0", exports });

function pack(tools: string): string {
  return `export const tools = ${tools};`;
}

const DESCRIBED = pack(`[{
  name: "build",
  description: "Build a screen. Pass \\\`slot\\\` only when the request names a place for it to land.",
  inputSchema: { type: "object", properties: { request: { type: "string" }, slot: { type: "string" } }, required: ["request"] },
}]`);

const BARE = pack(`[{
  name: "build",
  description: "Build a screen. Pass \\\`slot\\\` only when the request names a place for it to land.",
  inputSchema: { type: "object", properties: { request: { type: "string" }, slot: { type: "string" }, target: { type: "string" } }, required: ["request"] },
}]`);

async function report(from: Record<string, string>, to: Record<string, string>, subpaths?: string[]) {
  return buildReport({
    package: "@example/tools",
    from: "1.0.0",
    to: "2.0.0",
    registry: registryOf({ "@example/tools@1.0.0": from, "@example/tools@2.0.0": to }),
    cacheRoot: cacheRoot(),
    ...(subpaths ? { subpaths } : {}),
  });
}

describe("buildReport", () => {
  test("an unchanged contract is clean", async () => {
    const files = { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED };
    const result = await report(files, files);
    expect(result.verdict).toBe("clean");
    expect(exitCodeFor(result.verdict)).toBe(0);
  });

  test("a new undocumented optional parameter is prose-risk", async () => {
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED },
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": BARE },
    );
    expect(result.verdict).toBe("prose-risk");
    expect(result.surfaces[0]?.prose.findings.map((f) => f.target)).toEqual(["build.target"]);
    expect(exitCodeFor(result.verdict)).toBe(1);
  });

  test("reads every door the package declares, without being told", async () => {
    const files = {
      "package.json": manifest({ ".": "./index.js", "./pack": "./pack.js", "./other": "./other.js" }),
      "index.js": "export const version = 1;",
      "pack.js": DESCRIBED,
      "other.js": DESCRIBED,
    };
    const result = await report(files, files);
    // A package with three entry points has three contracts, and each is read
    // on its own. Two doors of one version routinely disagree.
    expect(result.surfaces.map((s) => s.subpath).sort()).toEqual([".", "./other", "./pack"]);
  });

  test("never reports clean when it could not read the package", async () => {
    const broken = { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": "export const = ;;;" };
    const result = await report(broken, broken, ["./pack"]);
    // Silence from a failed read is not evidence of no change.
    expect(result.verdict).toBe("unreadable");
    expect(exitCodeFor(result.verdict)).toBe(2);
  });

  test("a surface that did not exist before is not a pile of changes", async () => {
    const result = await report(
      { "package.json": manifest({ ".": "./index.js" }), "index.js": "export const v = 1;" },
      { "package.json": manifest({ ".": "./index.js", "./pack": "./pack.js" }), "index.js": "export const v = 2;", "pack.js": DESCRIBED },
    );
    const introduced = result.surfaces.find((s) => s.subpath === "./pack");
    expect(introduced?.comparison.kind).toBe("surface_introduced");
    expect(introduced?.comparison.diff).toBeNull();
  });

  test("a withdrawn entry point is breaking", async () => {
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED },
      { "package.json": manifest({ ".": "./index.js" }), "index.js": "export const v = 2;" },
    );
    expect(result.verdict).toBe("structurally-breaking");
    expect(result.headline).toContain("./pack");
  });

  test("records that no judge ran, so an unconfirmed finding reads as one", async () => {
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED },
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": BARE },
    );
    expect(result.judge).toBe("none");
    expect(result.surfaces[0]?.prose.findings[0]?.confidence).toBe("unconfirmed");
  });

  test("never returns behaviour-breaking, because Layer 2 is not built", async () => {
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED },
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": BARE },
    );
    // The value exists in the enum so CI branching does not change when Layer 2
    // lands. Nothing may emit it until a model has actually been replayed.
    expect(result.verdict).not.toBe("behaviour-breaking");
  });
});

describe("exitCodeFor", () => {
  test("three values a CI step can branch on without parsing", () => {
    expect(exitCodeFor("clean")).toBe(0);
    expect(exitCodeFor("prose-risk")).toBe(1);
    expect(exitCodeFor("structurally-breaking")).toBe(1);
    expect(exitCodeFor("unreadable")).toBe(2);
  });
});
