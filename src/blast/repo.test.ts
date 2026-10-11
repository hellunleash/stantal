import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIgnored, memoryRepoSource, withoutFiles } from "./repo.js";

/**
 * A spec kept in the repository it is compared from names every one of its own
 * operations. Scanned, it reported the contract reaching itself.
 */
describe("withoutFiles", () => {
  const repo = memoryRepoSource({
    "package.json": "{}",
    "src/billing.ts": "client.accountSessions.create()",
    "specs/after.json": '{"paths":{"/v1/account_sessions":{}}}',
  });

  it("leaves the named documents out of the listing", () => {
    const scanned = withoutFiles(repo, ["specs/after.json"]);
    expect(scanned.files()).not.toContain("specs/after.json");
    expect(scanned.files()).toContain("src/billing.ts");
  });

  it("still reads them, since being an input does not make a file unreadable", () => {
    expect(withoutFiles(repo, ["specs/after.json"]).read("specs/after.json")).toContain("account_sessions");
  });

  it("keeps the repo's own manifest", () => {
    expect(withoutFiles(repo, ["specs/after.json"]).packageJson()).toEqual({});
  });

  it("is the same source when nothing is named", () => {
    expect(withoutFiles(repo, [])).toBe(repo);
  });
});

/**
 * `gitIgnored` fails open, which is the right default and also means a broken
 * one is invisible: everything stays visible and nothing looks wrong. So the
 * test that matters is that it really does answer.
 */
describe("gitIgnored", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stantal-ignore-"));
    mkdirSync(join(root, "scratch"), { recursive: true });
    writeFileSync(join(root, "kept.json"), "{}", "utf8");
    writeFileSync(join(root, "scratch", "out.json"), "{}", "utf8");
    // A nested ignore file holding a single `*`: a directory whose owner
    // ignores it on purpose. This is the shape found in the field.
    writeFileSync(join(root, "scratch", ".gitignore"), "*\n", "utf8");
    spawnSync("git", ["-C", root, "init", "-q"], { windowsHide: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a nested .gitignore the way git does", () => {
    expect([...gitIgnored(root, ["kept.json", "scratch/out.json"])]).toEqual(["scratch/out.json"]);
  });

  it("is empty, never wrong, when git cannot answer", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "stantal-plain-"));
    try {
      expect(gitIgnored(notARepo, ["anything.json"]).size).toBe(0);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("asks nothing when there is nothing to ask about", () => {
    expect(gitIgnored(root, []).size).toBe(0);
  });
});
