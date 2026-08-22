import { describe, expect, test } from "vitest";
import {
  declaredEntryPoints,
  memoryPackageSource,
  resolveEntryPoint,
  resolveSpecifier,
} from "./package-source.js";

const MANIFEST = {
  name: "@example/tools",
  version: "2.0.0",
  exports: {
    ".": { import: "./dist/index.js", require: "./dist/index.cjs" },
    "./pack": { import: "./dist/pack.js" },
  },
};

function pkg(files: Record<string, string> = {}) {
  return memoryPackageSource({
    "package.json": JSON.stringify(MANIFEST),
    "dist/index.js": "export const a = 1;",
    "dist/pack.js": "export const b = 2;",
    ...files,
  });
}

describe("declaredEntryPoints", () => {
  test("follows the condition the consumer would hit", () => {
    expect(declaredEntryPoints(MANIFEST, { subpath: "." })).toEqual(["./dist/index.js"]);
    expect(declaredEntryPoints(MANIFEST, { subpath: ".", condition: "require" })).toEqual([
      "./dist/index.cjs",
    ]);
  });

  test("an unlisted subpath is not exported, not an error", () => {
    // This is the "surface absent at this version" case at its source: the
    // package simply does not offer that door.
    expect(declaredEntryPoints(MANIFEST, { subpath: "./mastra" })).toBeNull();
  });

  test("falls back to main when there is no exports field", () => {
    expect(declaredEntryPoints({ name: "old", main: "./lib/index.js" }, {})).toEqual(["./lib/index.js"]);
    expect(declaredEntryPoints({ name: "old" }, {})).toEqual(["./index.js"]);
  });
});

describe("resolveEntryPoint", () => {
  test("finds the file the manifest points at", () => {
    const entry = resolveEntryPoint(pkg(), { subpath: "./pack" });
    expect(entry).toMatchObject({ found: true, path: "dist/pack.js" });
  });

  test("reports a subpath the package does not offer", () => {
    const entry = resolveEntryPoint(pkg(), { subpath: "./mastra" });
    expect(entry).toMatchObject({ found: false, reason: "not_exported" });
  });

  test("separates a missing file from a missing export", () => {
    const source = memoryPackageSource({ "package.json": JSON.stringify(MANIFEST) });
    const entry = resolveEntryPoint(source, { subpath: "./pack" });
    // The package promised a file it did not ship. Different defect, different name.
    expect(entry).toMatchObject({ found: false, reason: "file_missing" });
  });

  test("probes extensionless and directory entries", () => {
    const source = memoryPackageSource({
      "package.json": JSON.stringify({ name: "x", exports: { ".": "./lib/main" } }),
      "lib/main/index.js": "export const a = 1;",
    });
    expect(resolveEntryPoint(source)).toMatchObject({ found: true, path: "lib/main/index.js" });
  });
});

describe("resolveSpecifier", () => {
  test("resolves a relative import inside the package", () => {
    const source = pkg({ "dist/names.js": "export const N = 'build';" });
    const resolved = resolveSpecifier("./names.js", "dist/pack.js", source);
    expect(resolved?.path).toBe("dist/names.js");
  });

  test("crosses into a dependency, because that is where tool names live", () => {
    const core = memoryPackageSource({
      "package.json": JSON.stringify({ name: "@example/core", exports: { ".": "./index.js" } }),
      "index.js": "export const BUILD_TOOL = 'build';",
    });
    const source = memoryPackageSource(
      { "package.json": JSON.stringify(MANIFEST), "dist/pack.js": "" },
      { "@example/core": core },
    );
    const resolved = resolveSpecifier("@example/core", "dist/pack.js", source);
    expect(resolved?.source).toBe(core);
    expect(resolved?.path).toBe("index.js");
  });

  test("does not follow node builtins", () => {
    expect(resolveSpecifier("node:fs", "dist/pack.js", pkg())).toBeNull();
  });

  test("a package that is not installed is unresolved, not an error", () => {
    expect(resolveSpecifier("@example/missing", "dist/pack.js", pkg())).toBeNull();
  });
});
