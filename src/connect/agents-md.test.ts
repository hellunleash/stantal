import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { agentsSection, writeAgentsMd } from "./agents-md.js";
import { publishesContract } from "./publishes.js";

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

  test("tells the agent what to do when the tool it mandates is not loaded yet", () => {
    // connect writes this file and the server's config in the same run, and the
    // server does not load until a restart. So the very first read of this file
    // is the moment audit_project is most likely to be missing — and the
    // fallback it would otherwise reach for is forbidden two lines above.
    expect(section).toContain("If `audit_project` is not available to you");
    expect(section).toContain("has not started yet");
    expect(section).toContain("npx stantal --json");
    expect(section).toContain("they will be missing too");
  });

  test("stamps the version that wrote it", () => {
    // Nothing else versions this file. Written once and frozen, it starts lying
    // the day a release renames a tool — the drift problem this product sells
    // against, in this product's own artifact.
    expect(agentsSection("1.2.3")).toContain("written by 1.2.3");
    expect(agentsSection("1.2.3")).toContain("npx stantal connect");
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

/**
 * A repository that publishes a contract has the problem from the side that
 * causes it, and none of the consumer rows will ever mention that.
 */
describe("the provider branch", () => {
  const facts = { package: "@acme/tools", subpaths: [".", "./ai-sdk"], tools: 7 };

  test("is absent from a repository that publishes nothing", () => {
    // A section about publishing, in a project that publishes nothing, is noise
    // in the one file every agent reads first.
    expect(agentsSection()).not.toContain("This repository also publishes a contract");
    expect(agentsSection()).not.toContain("check_release");
  });

  test("names the package, the entry points and the two commands", () => {
    const section = agentsSection("1.0.0", facts);
    expect(section).toContain("This repository also publishes a contract");
    expect(section).toContain("`@acme/tools` ships 7 tool(s)");
    expect(section).toContain("`.`, `./ai-sdk`");
    expect(section).toContain("check_release");
    expect(section).toContain("compare_manifests");
  });

  test("says the gate runs before publishing, not after", () => {
    // Afterwards the only fix is another release, which is the whole reason a
    // provider wants this at all.
    expect(agentsSection("1.0.0", facts)).toContain("before `npm publish`, not after");
  });

  test("keeps the consumer half as well", () => {
    // Every provider is also a consumer. Replacing one briefing with the other
    // would trade one blind spot for the opposite one.
    const section = agentsSection("1.0.0", facts);
    expect(section).toContain("audit_project");
    expect(section).toContain("Saying it accurately");
  });
});

describe("publishesContract", () => {
  function repo(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "stantal-publishes-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest), "utf8");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
    return dir;
  }

  const PACK = 'export const tools = [{ name: "build", description: "Build a screen.", inputSchema: { type: "object", properties: {} } }];';

  test("reads this project's own build with the extractor a consumer would use", () => {
    const dir = repo({ name: "@acme/tools", version: "1.0.0", exports: { ".": "./pack.js" } }, { "pack.js": PACK });
    const facts = publishesContract(dir);
    expect(facts?.package).toBe("@acme/tools");
    expect(facts?.tools).toBe(1);
  });

  test("a package with a name and no tools is not a provider", () => {
    // Most repositories have a name. Only a tool set makes this the question.
    const dir = repo({ name: "app", version: "1.0.0", exports: { ".": "./index.js" } }, { "index.js": "export const x = 1;" });
    expect(publishesContract(dir)).toBeNull();
  });

  test("a private package is not published, so it is not a provider", () => {
    const dir = repo(
      { name: "@acme/tools", private: true, version: "1.0.0", exports: { ".": "./pack.js" } },
      { "pack.js": PACK },
    );
    expect(publishesContract(dir)).toBeNull();
  });
});

describe("the automation section", () => {
  const section = agentsSection();

  test("names both workflows and where they ship", () => {
    // Copying beats retyping: the agent has the exact file, and a workflow it
    // invented would be a workflow nobody reviewed.
    expect(section).toContain("node_modules/stantal/templates/");
    expect(section).toContain("stantal-watch.yml");
    expect(section).toContain("stantal-release-gate.yml");
  });

  test("makes the agent ask before adding one", () => {
    // A scheduled workflow spends Actions minutes and can open pull requests.
    // That is a larger thing to add unasked than a config file.
    expect(section).toContain("Ask before adding either one");
  });
});
