import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The briefing a coding agent reads instead of being told what to do.
 *
 * `setupPrompt()` is a fixed list of steps, which is fine and is also the whole
 * problem: it makes the same four calls in a repository with one contract
 * dependency and in one with twelve, and it asks the person nothing. A file the
 * agent reads first can branch on what it actually found, and the questions it
 * ends up asking are about this project rather than about the average one.
 *
 * `AGENTS.md` because that is the convention agents already look for. Written
 * into the user's repository so it travels with the project: whoever clones it
 * next gets the same briefing without installing anything.
 *
 * **Merged, never replaced**, the same rule as `.mcp.json`. A repository that
 * already has an `AGENTS.md` has one for a reason, and taking it out would be a
 * worse outcome than anything this product reports.
 */

const BEGIN = "<!-- begin: stantal -->";
const END = "<!-- end: stantal -->";

export type WriteAgentsResult = {
  file: string;
  action: "created" | "updated" | "appended";
  /** Bytes of somebody else's content that were left exactly as they were. */
  preserved: number;
};

/**
 * The section itself.
 *
 * Written as a decision procedure, not a script. Every question is conditional
 * on something the audit reported, because a question the data does not support
 * is a question the person has to work out how to dismiss — and two of those
 * and they stop reading.
 */
export function agentsSection(): string {
  return [
    BEGIN,
    "",
    "## Contract drift (stantal)",
    "",
    "This project depends on packages that hand **a language model** a set of tools:",
    "names, descriptions, parameters. That description is the contract. A release can",
    "delete the sentence explaining when to pass a parameter, and nothing — not semver,",
    "not the type-checker, not the test suite — will notice. The model just starts",
    "getting it wrong.",
    "",
    "The `stantal` MCP server is configured in this repository. Use it.",
    "",
    "### Start here, every time",
    "",
    "Call **`audit_project`** once. One call answers all of it: which dependencies hand",
    "a model tools, what upgrade is waiting for each, what that upgrade changes, which",
    "of this project's files it reaches, and what is already covered by tests.",
    "",
    "Do not call `list_contract_dependencies` and `check_upgrade` separately to work",
    "this out. They exist for going deeper on one package after `audit_project` has",
    "named it.",
    "",
    "### Then ask about what it actually found",
    "",
    "Read the result and ask only the questions it supports. Ask them together, not one",
    "at a time. If a condition below is not met, say nothing about it.",
    "",
    "| If the audit says | Ask |",
    "|---|---|",
    "| `contract_dependencies` is 0 | Nothing. Report that no dependency here can be affected, and stop. |",
    "| any dependency has `pinned: false` | \"Shall I write contract tests for these N packages? They pass today and fail the day an upgrade removes any of it.\" Name the packages. |",
    "| any has `upgrade_available` and a `verdict` other than `clean` | \"`<pkg>` `<installed>` → `<latest>` changes what a model reads: `<headline>`. Do you want to take it, hold it, or look at the detail?\" |",
    "| that entry also has a non-empty `reaches` | Name the two or three files first. Those are the places a person has to look, and they change the answer. |",
    "| that entry has `held_by_declared_range: true` | Say the range already excludes it and ask nothing. There is nothing to decide today. |",
    "| any has `unreachable: true` | \"I could not read `<pkg>`, so I am not claiming anything about it. Want me to retry?\" Never let this pass as clean. |",
    "| `can_run_tests` is false | \"Nothing here runs tests, so contract tests would never execute. Shall I add a runner?\" Ask this **before** writing any tests. |",
    "",
    "### Doing the work",
    "",
    "- **Write tests only after they say yes.** `pin_contract` per package, or",
    "  `npx stantal pin --all` for every one at once. It never overwrites an existing",
    "  suite.",
    "- **Never upgrade a dependency on your own.** Report the verdict and let them",
    "  decide. Taking an upgrade because a tool flagged it is the failure this",
    "  project exists to prevent, run in reverse.",
    "- **Never edit source to work around a finding.** The finding is about the",
    "  package's contract, not about their code.",
    "- **Run the test suite once** after writing tests, and report whether it passed.",
    "",
    "### Saying it accurately",
    "",
    "- A finding is *something a model would read differently*. It is not a bug, an",
    "  error or a vulnerability, and calling it one will get this tool uninstalled.",
    "- `unconfirmed` means no model was available to settle a judgement call. It does",
    "  not mean the finding is doubtful.",
    "- \"We could not read it\" is never \"it is fine.\" If `unreachable` is true for a",
    "  package, say so in the same breath as anything else you report.",
    "",
    END,
  ].join("\n");
}

/**
 * Write or refresh the section, keeping everything else in the file.
 *
 * The markers are what make a second run an update rather than a duplicate. A
 * tool that appends its own block every time it runs turns a useful file into
 * an unreadable one within a month.
 */
export function writeAgentsMd(directory: string, filename = "AGENTS.md"): WriteAgentsResult {
  const file = join(directory, filename);
  const section = agentsSection();

  if (!existsSync(file)) {
    writeFileSync(file, `# Agent notes\n\n${section}\n`, "utf8");
    return { file: filename, action: "created", preserved: 0 };
  }

  const existing = readFileSync(file, "utf8");
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);

  if (start !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + END.length);
    writeFileSync(file, `${before}${section}${after}`, "utf8");
    return { file: filename, action: "updated", preserved: before.length + after.length };
  }

  // Somebody else's file, with no section of ours in it. Appended rather than
  // merged into their prose: we have no idea what their headings mean, and a
  // block at the end is both obvious to find and trivial to delete.
  writeFileSync(file, `${existing.trimEnd()}\n\n${section}\n`, "utf8");
  return { file: filename, action: "appended", preserved: existing.length };
}
