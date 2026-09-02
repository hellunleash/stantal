import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { CONTRACT_CONFIG, CONTRACT_SCRIPT, setupRunner } from "./runner.js";

describe("setupRunner", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stantal-runner-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer" }), "utf8");
  });

  const setup = () => setupRunner({ root, testDir: "stantal", generator: "stantal 0.5.0" });
  const manifest = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;

  test("writes a config scoped to the contract tests, and a script that runs it", () => {
    const result = setup();

    expect(result.config).toBe(CONTRACT_CONFIG);
    expect(result.script).toBe(true);

    const config = readFileSync(join(root, CONTRACT_CONFIG), "utf8");
    // Scoped, so it can never collect somebody else's suite — which is what a
    // bare `vitest run` did in a real install, 153 files instead of 7.
    expect(config).toContain('"stantal/**/*.contract.test.ts"');

    const scripts = manifest()["scripts"] as Record<string, string>;
    expect(scripts[CONTRACT_SCRIPT]).toBe(`vitest run --config ${CONTRACT_CONFIG}`);
  });

  test("never overwrites a config that is already there", () => {
    writeFileSync(join(root, CONTRACT_CONFIG), "// mine\n", "utf8");
    const result = setup();

    expect(result.config).toBeNull();
    expect(readFileSync(join(root, CONTRACT_CONFIG), "utf8")).toBe("// mine\n");
    expect(result.notes.join(" ")).toContain("left alone");
  });

  test("never overwrites a script that is already there", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", scripts: { [CONTRACT_SCRIPT]: "mine" } }),
      "utf8",
    );

    const result = setup();
    expect(result.script).toBe(false);
    expect((manifest()["scripts"] as Record<string, string>)[CONTRACT_SCRIPT]).toBe("mine");
  });

  test("leaves the project's own scripts exactly as they were", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", scripts: { test: "jest", build: "tsc" } }),
      "utf8",
    );

    setup();
    const scripts = manifest()["scripts"] as Record<string, string>;
    // Their suite is how their CI runs. Touching it would be a worse outcome
    // than any finding this tool reports.
    expect(scripts["test"]).toBe("jest");
    expect(scripts["build"]).toBe("tsc");
    expect(scripts[CONTRACT_SCRIPT]).toContain("vitest run");
  });

  test("a manifest it cannot parse is a note, never a failure", () => {
    writeFileSync(join(root, "package.json"), "{ not json", "utf8");
    const result = setup();

    // The tests are already written and are the point. An unparseable manifest
    // usually means somebody is in the middle of editing it.
    expect(result.config).toBe(CONTRACT_CONFIG);
    expect(result.script).toBe(false);
    expect(result.notes.join(" ")).toContain(CONTRACT_SCRIPT);
  });
});
