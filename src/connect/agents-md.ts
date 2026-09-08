import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishesContract, type ProviderFacts } from "./publishes.js";

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
export function agentsSection(version = "0.0.0", provider: ProviderFacts | null = null): string {
  return [
    BEGIN,
    // Stamped so a later run can tell that this block is older than the CLI
    // that would write it. Nothing versions this file otherwise: it is written
    // once and frozen, and if a release renames a tool the file starts lying
    // about it — which is the drift problem this product sells against,
    // occurring in this product's own artifact.
    `<!-- stantal: written by ${version}. Re-run \`npx stantal connect\` to refresh. -->`,
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
    "of this project's files it reaches, what is already covered by tests, and which",
    "contracts this repository writes itself.",
    "",
    "Do not call `list_contract_dependencies` and `check_upgrade` separately to work",
    "this out. They exist for going deeper on one package after `audit_project` has",
    "named it.",
    "",
    "**If `audit_project` is not available to you, the MCP server has not started yet.**",
    "This file and the server's config are written by the same command, and the server",
    "does not load until the agent restarts — so the first read of this file is exactly",
    "the moment the tool is most likely to be missing. Do not fall back to the other",
    "tools; they will be missing too. Run `npx stantal --json` in the terminal instead —",
    "it is the same audit, and the fields below are the fields it returns. If you cannot",
    "run commands either, say the server needs a restart and stop.",
    "",
    "### Then ask about what it actually found",
    "",
    "Read the result and ask only the questions it supports. Ask them together, not one",
    "at a time. If a condition below is not met, say nothing about it.",
    "",
    "| If the audit says | Ask |",
    "|---|---|",
    "| `contract_dependencies` is 0 **and** `authored_contracts` is empty | Nothing. Report that nothing here can be affected, and stop. |",
    "| `contract_dependencies` is 0 and `authored_contracts` is not | Do not report this project as covered. No *dependency* can be affected; the contract it writes still can. |",
    "| any entry of `authored_contracts` has `has_baseline: false` | \"This repo writes `<catalog>`, `<tools>` tools a model reads. Nothing is recorded, so a regeneration changes it silently. Shall I run `npx stantal snapshot --save` and commit the copy?\" |",
    "| `authored_unreadable` is not empty | Say which documents could not be read. They are not evidence that nothing is there. |",
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
    "- **A baseline is committed, not generated on demand.** `npx stantal snapshot --save`",
    "  writes a copy of each generated contract under `.stantal/contracts`. It is only",
    "  worth anything if it is committed, because the comparison is against what was",
    "  there last time.",
    "- **Never upgrade a dependency on your own.** Report the verdict and let them",
    "  decide. Taking an upgrade because a tool flagged it is the failure this",
    "  project exists to prevent, run in reverse.",
    "- **Never edit source to work around a finding.** The finding is about the",
    "  package's contract, not about their code.",
    "- **Run the test suite once** after writing tests, and report whether it passed.",
    "",
    ...providerSection(provider),
    "### Saying it accurately",
    "",
    "- A finding is *something a model would read differently*. It is not a bug, an",
    "  error or a vulnerability, and calling it one will get this tool uninstalled.",
    "- `unconfirmed` means no model was available to settle a judgement call. It does",
    "  not mean the finding is doubtful.",
    "- \"We could not read it\" is never \"it is fine.\" If `unreachable` is true for a",
    "  package, say so in the same breath as anything else you report.",
    "- A **stale quote** is the sharpest thing here and the easiest to overstate. It",
    "  means a file in this repo still contains, word for word, a sentence the newer",
    "  contract deleted — usually a system prompt. Say which file and quote the",
    "  sentence. Do not say the prompt is wrong; say the contract no longer",
    "  describes what it tells the model.",
    "",
    END,
  ].join("\n");
}

/**
 * The other end of the dependency, when this repository is at it.
 *
 * Everything above is the consumer's question: something I install is about to
 * move under me. A repository that publishes a contract of its own has the
 * problem from the side that causes it, and none of the rows above will ever
 * mention it — a provider is briefed entirely about the half of the product
 * they care about least, which is what this section fixes.
 *
 * Emitted only when the extractor actually read tools out of this project's own
 * build. A section about publishing, written into a repository that publishes
 * nothing, is noise in the one file every agent reads first.
 */
function providerSection(provider: ProviderFacts | null): string[] {
  if (provider === null) return [];
  const doors = provider.subpaths.join("`, `");
  return [
    "### This repository also publishes a contract",
    "",
    `\`${provider.package}\` ships ${provider.tools} tool(s) a model reads, on \`${doors}\`.`,
    "So the question runs both ways here: what an upgrade does to this project, and",
    "what **this project's next release** does to the models already calling it.",
    "",
    "Nobody downstream gets a warning. Their semver check passes, their types compile",
    "and their tests are green, because everything that moved is prose.",
    "",
    "| Before you | Call |",
    "|---|---|",
    "| publish a release | **`check_release`** with this directory and the last published version. Do it before `npm publish`, not after — afterwards the only fix is another release. |",
    "| change a tool description or a parameter | Same call. A deleted sentence is the finding this product exists for and it is invisible to every other check you run. |",
    "| ship a contract that never goes to a registry | **`compare_manifests`** with the two documents. Nothing is fetched and no version is resolved. |",
    "",
    "- **Never delete a sentence of guidance to shorten a description.** If it has to",
    "  go, say so in the release notes in the same words the sentence used, so a",
    "  consumer grepping for it finds something.",
    "- **A new optional parameter needs a sentence saying when to pass it.** Without",
    "  one a model fills it because it is there, which is the anchoring failure this",
    "  whole tool was built around.",
    "- Report what `check_release` found and let them decide. Do not edit a",
    "  description to make a finding go away.",
    "",
  ];
}

/**
 * Write or refresh the section, keeping everything else in the file.
 *
 * The markers are what make a second run an update rather than a duplicate. A
 * tool that appends its own block every time it runs turns a useful file into
 * an unreadable one within a month.
 */
export function writeAgentsMd(directory: string, version = "0.0.0", filename = "AGENTS.md"): WriteAgentsResult {
  const file = join(directory, filename);
  // Read, not asked. Whether this repo publishes a contract is a fact about its
  // own build, and a question here would be one more thing to get wrong on a
  // command whose whole point is that it needs no configuration.
  const section = agentsSection(version, publishesContract(directory));

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
