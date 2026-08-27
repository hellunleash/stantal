import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emitTests, type EmitTarget } from "./write.js";
import type { Assertion } from "./taxonomy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stantal-emit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function target(subpath: string, assertions: Assertion[]): EmitTarget {
  return { package: "@example/tools", subpath, assertions, version: "1.4.0" };
}

function pin(tool: string, subpath = "./pack"): Assertion {
  return { kind: "tool_present", subpath, tool, why: "pinned" };
}

describe("one file per door", () => {
  test("two subpaths produce two files", () => {
    // Two doors of one package are two contracts, read separately and free to
    // disagree. A shared file could not say which import a failure belongs to.
    const written = emitTests({
      directory: dir,
      targets: [target("./pack", [pin("build")]), target("./ai-sdk", [pin("build", "./ai-sdk")])],
    });

    expect(written).toHaveLength(2);
    expect(readdirSync(dir).sort()).toEqual([
      "example-tools.ai-sdk.contract.test.ts",
      "example-tools.pack.contract.test.ts",
    ]);
  });

  test("the file loads the door it was written for", () => {
    emitTests({ directory: dir, targets: [target("./ai-sdk", [pin("build", "./ai-sdk")])] });
    const contents = readFileSync(join(dir, "example-tools.ai-sdk.contract.test.ts"), "utf8");
    expect(contents).toContain(`subpath: "./ai-sdk"`);
  });
});

describe("a door with nothing to pin is skipped, not written empty", () => {
  test("no file appears for an empty target", () => {
    // An empty file in a test directory reads as coverage. Reading absence as
    // coverage is the one mistake the rest of this codebase exists to avoid.
    const written = emitTests({ directory: dir, targets: [target("./pack", [])] });
    expect(written).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the directory is not even created when there is nothing to write", () => {
    const fresh = join(dir, "nested", "deeper");
    emitTests({ directory: fresh, targets: [target("./pack", [])] });
    expect(() => readdirSync(fresh)).toThrow();
  });

  test("empty doors are dropped while real ones are still written", () => {
    const written = emitTests({
      directory: dir,
      targets: [target("./pack", []), target("./ai-sdk", [pin("build", "./ai-sdk")])],
    });
    expect(written.map((w) => w.subpath)).toEqual(["./ai-sdk"]);
  });
});

describe("what the caller is told", () => {
  test("each written file reports its path, door and assertion count", () => {
    const written = emitTests({
      directory: dir,
      targets: [target("./pack", [pin("build"), pin("deploy")])],
    });
    expect(written[0]).toMatchObject({ subpath: "./pack", assertions: 2 });
    expect(written[0]?.path).toContain("example-tools.pack.contract.test.ts");
  });

  test("a dry run reports what it would write and writes nothing", () => {
    const written = emitTests({
      directory: dir,
      targets: [target("./pack", [pin("build")])],
      dryRun: true,
    });
    expect(written).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("rewriting", () => {
  test("a second run replaces the file rather than appending to it", () => {
    emitTests({ directory: dir, targets: [target("./pack", [pin("build"), pin("deploy")])] });
    emitTests({ directory: dir, targets: [target("./pack", [pin("build")])] });

    const contents = readFileSync(join(dir, "example-tools.pack.contract.test.ts"), "utf8");
    expect(contents).toContain("still offers build");
    expect(contents).not.toContain("still offers deploy");
  });
});
