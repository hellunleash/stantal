import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { agentsSection, writeAgentsMd } from "./agents-md.js";

describe("writeAgentsMd", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stantal-agents-"));
  });

  const read = () => readFileSync(join(dir, "AGENTS.md"), "utf8");

  test("creates the file when there is none", () => {
    const result = writeAgentsMd(dir);
    expect(result.action).toBe("created");
    expect(result.preserved).toBe(0);
    expect(read()).toContain("Contract drift (stantal)");
  });

  test("appends to somebody else's file without touching it", () => {
    const theirs = "# How we work\n\nAlways run the linter before committing.\n";
    writeFileSync(join(dir, "AGENTS.md"), theirs, "utf8");

    const result = writeAgentsMd(dir);
    expect(result.action).toBe("appended");
    // The thing a careful person is actually worried about when a tool edits a
    // file they wrote.
    expect(read()).toContain("Always run the linter before committing.");
    expect(read()).toContain("Contract drift (stantal)");
    expect(result.preserved).toBe(theirs.length);
  });

  test("a second run updates in place rather than appending again", () => {
    writeAgentsMd(dir);
    writeAgentsMd(dir);
    writeAgentsMd(dir);

    // A tool that appends its own block on every run turns a useful file into
    // an unreadable one within a month.
    const occurrences = read().split("Contract drift (stantal)").length - 1;
    expect(occurrences).toBe(1);
  });

  test("an update keeps what is around it, on both sides", () => {
    writeFileSync(
      join(dir, "AGENTS.md"),
      `# Ours\n\nbefore-marker\n\n${agentsSection()}\n\nafter-marker\n`,
      "utf8",
    );

    const result = writeAgentsMd(dir);
    expect(result.action).toBe("updated");
    expect(read()).toContain("before-marker");
    expect(read()).toContain("after-marker");
  });
});

describe("the briefing itself", () => {
  const section = agentsSection();

  test("sends the agent to one call, not to a sequence it has to assemble", () => {
    expect(section).toContain("audit_project");
    expect(section).toContain("Do not call `list_contract_dependencies` and `check_upgrade` separately");
  });

  test("makes every question conditional on something the audit reported", () => {
    // A question the data does not support is one the person has to work out
    // how to dismiss, and two of those and they stop reading.
    expect(section).toContain("ask only the questions it supports");
  });

  test("forbids the agent upgrading or editing source on its own", () => {
    expect(section).toContain("Never upgrade a dependency on your own");
    expect(section).toContain("Never edit source to work around a finding");
  });

  test("carries the vocabulary that keeps the claims honest", () => {
    // Every one of these is a claim this project must not let an agent overstate
    // on its behalf.
    expect(section).toContain("It is not a bug, an");
    expect(section).toContain("error or a vulnerability");
    expect(section).toContain("`unconfirmed` means no model was available");
    expect(section).toContain('"We could not read it" is never "it is fine."');
  });
});
