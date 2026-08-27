import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hostReadiness, readinessNotes } from "./host.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stantal-host-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manifest(value: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(value), "utf8");
}

/** Put a package on disk, because resolution walks node_modules rather than reading a manifest. */
function installed(name: string): void {
  const at = join(dir, "node_modules", name);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "package.json"), JSON.stringify({ name, version: "1.0.0" }), "utf8");
}

describe("what the generated files need", () => {
  test("reports both imports missing in a bare project", () => {
    // The situation that broke a real repository: five TypeScript files written
    // into an app whose tsconfig globs the tree, importing two packages it had
    // never installed. Its type-check went from passing to ten errors.
    manifest({ name: "app", private: true });
    expect(hostReadiness(dir).missing).toEqual(["vitest", "stantal"]);
  });

  test("resolution walks node_modules, not the manifest", () => {
    // A package listed in devDependencies but never installed would pass a
    // manifest check and still fail every import at run time.
    manifest({ name: "app", devDependencies: { vitest: "^2.0.0", stantal: "^0.3.0" } });
    expect(hostReadiness(dir).missing).toEqual(["vitest", "stantal"]);

    installed("vitest");
    installed("stantal");
    expect(hostReadiness(dir).missing).toEqual([]);
  });
});

describe("whether anything would run them", () => {
  test("a project with no test script has no runner", () => {
    // Common in app repos, where the gate is a type-check. A suite nobody runs
    // cannot fail when an upgrade removes something, which is the whole point.
    manifest({ name: "app", scripts: { build: "next build" } });
    expect(hostReadiness(dir).hasRunner).toBe(false);
  });

  test("npm's placeholder test script does not count", () => {
    manifest({ name: "app", scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    const readiness = hostReadiness(dir);
    expect(readiness.hasRunner).toBe(false);
    expect(readiness.testScript).toBeNull();
  });

  test("a script that invokes a known runner counts", () => {
    manifest({ name: "app", scripts: { test: "vitest run" } });
    expect(hostReadiness(dir).hasRunner).toBe(true);
  });

  test("an installed runner counts even with no script for it", () => {
    // Plenty of people just run `npx vitest`.
    manifest({ name: "app" });
    installed("vitest");
    expect(hostReadiness(dir).hasRunner).toBe(true);
  });
});

describe("what the user is told", () => {
  test("a ready project gets one line and no warnings", () => {
    manifest({ name: "app", scripts: { test: "vitest run" } });
    installed("vitest");
    installed("stantal");
    // A ready project gets one useful line and no advice it does not need.
    // Warnings nobody needs are how real warnings get skimmed past.
    const notes = readinessNotes(hostReadiness(dir), dir);
    expect(notes).toEqual(["Run them with:  npm test"]);
  });

  test("missing imports produce the exact install command", () => {
    manifest({ name: "app" });
    const notes = readinessNotes(hostReadiness(dir), dir).join("\n");
    expect(notes).toContain("npm install -D vitest stantal");
    expect(notes).toContain("type-check here will fail");
  });

  test("no runner is called out as making the suite pointless", () => {
    // Without vitest there is nothing to run them, and nothing to import from
    // either — in practice the two arrive together.
    manifest({ name: "app" });
    installed("stantal");
    const notes = readinessNotes(hostReadiness(dir), dir).join("\n");
    expect(notes).toContain("never execute");
    expect(notes).toContain('npm pkg set scripts.test="vitest run"');
  });

  test("a type-checked project is warned where the failure will surface", () => {
    // The failure appears in a command that has nothing to do with testing,
    // which is why it read as this tool breaking the build.
    manifest({ name: "app" });
    writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
    expect(readinessNotes(hostReadiness(dir), dir).join("\n")).toContain("build");
  });

  test("a project that can run them is simply told how", () => {
    manifest({ name: "app", scripts: { test: "vitest run" } });
    installed("vitest");
    installed("stantal");
    manifest({ name: "app", scripts: { test: "vitest run" } });
    expect(readinessNotes(hostReadiness(dir), dir).join("\n")).toContain("npm test");
  });
});
