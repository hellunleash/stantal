import type { Contract, Param, Tool } from "../contract/types.js";
import type { ExtractionNote } from "../contract/surface.js";
import type { StructuralChange } from "../diff/structural.js";
import type { ProseFinding } from "../prose/taxonomy.js";
import type { Report } from "../report.js";
import { type Assertion, EARNS_A_TEST, assertionKey, paramIsDocumented } from "./taxonomy.js";

/**
 * Turning findings into assertions.
 *
 * One rule governs everything in this file, and it is the only thing standing
 * between a useful artifact and a liability:
 *
 * > **Every assertion is verified against the contract it will be pinned to
 * > before it is emitted.**
 *
 * An assertion derived from a finding describes the side the consumer depends
 * on *now*. If that description is wrong, the generated test fails the moment
 * it is written, on a version where nothing is wrong — and a test that has
 * never once passed is deleted unread, taking the real findings in the same
 * file with it.
 *
 * So a finding proposes an assertion and the contract confirms it. Nothing is
 * written on the strength of the finding alone.
 */

/** Find a tool by name. */
export function findTool(contract: Contract, name: string): Tool | null {
  return contract.tools.find((t) => t.name === name) ?? null;
}

/**
 * Find a parameter by dotted path, descending into nested object members.
 *
 * The structural differ reports `tool.options.limit` for a member three levels
 * down, so a lookup that only reads the top level would silently fail to verify
 * every nested assertion and drop it.
 */
export function findParam(contract: Contract, toolName: string, path: string): Param | null {
  const tool = findTool(contract, toolName);
  if (tool === null) return null;
  let current: Param[] = tool.params;
  let found: Param | null = null;
  for (const segment of path.split(".")) {
    found = current.find((p) => p.name === segment) ?? null;
    if (found === null) return null;
    current = found.children ?? [];
  }
  return found;
}

/** Split a differ target — `tool` or `tool.param.child` — into its two halves. */
function paramPath(target: string, tool: string): string | null {
  if (target === tool) return null;
  return target.startsWith(`${tool}.`) ? target.slice(tool.length + 1) : null;
}

/**
 * Is this claim actually true of this contract?
 *
 * The gate described at the top of the file. Returns false for anything it
 * cannot confirm, including a lookup that fails — an assertion about a tool we
 * cannot find is not "probably fine", it is unverifiable, and unverifiable
 * claims are the ones this project does not make.
 */
export function holds(assertion: Assertion, contract: Contract): boolean {
  const tool = findTool(contract, assertion.tool);
  if (tool === null) return false;
  if (assertion.kind === "tool_present") return true;

  if (assertion.kind === "description_includes") {
    const needle = typeof assertion.expected === "string" ? assertion.expected : null;
    if (needle === null || needle.trim().length === 0) return false;
    return tool.description !== null && tool.description.includes(needle);
  }

  if (assertion.param === undefined) return false;
  const param = findParam(contract, assertion.tool, assertion.param);
  if (param === null) return false;

  switch (assertion.kind) {
    case "param_present":
      return true;
    case "param_optional":
      return !param.required;
    case "param_required":
      return param.required;
    case "param_type":
      return param.type === assertion.expected;
    case "enum_includes": {
      const want = Array.isArray(assertion.expected) ? assertion.expected : null;
      const have = param.constraints.enum;
      if (want === null || have === undefined) return false;
      return want.every((v) => have.some((h) => Object.is(h, v)));
    }
    case "param_documented":
      return paramIsDocumented(tool.description, param);
    default:
      return false;
  }
}

/**
 * Tools whose parameters were not fully read, and tools whose prose was not.
 *
 * Same invariant the extractor is built around: a gap suppresses claims rather
 * than producing a confident empty answer. A tool whose schema could not be
 * read has an unknown parameter list, so "this parameter is present" is not
 * ours to assert — and neither is its absence.
 */
function gaps(notes: readonly ExtractionNote[]): { schema: Set<string>; prose: Set<string> } {
  const schema = new Set<string>();
  const prose = new Set<string>();
  for (const note of notes) {
    // A note's target is `tool` or `tool.param`; the tool is the first segment.
    const tool = note.target === null ? null : (note.target.split(".")[0] ?? null);
    if (tool === null) continue;
    if (note.scope === "schema") schema.add(tool);
    if (note.scope === "description") prose.add(tool);
  }
  return { schema, prose };
}

/** Drop duplicates and anything the contract will not confirm. */
function accept(
  proposed: readonly Assertion[],
  contract: Contract,
  notes: readonly ExtractionNote[],
): Assertion[] {
  const { schema, prose } = gaps(notes);
  const seen = new Set<string>();
  const out: Assertion[] = [];
  for (const a of proposed) {
    if (a.param !== undefined && schema.has(a.tool)) continue;
    if ((a.kind === "description_includes" || a.kind === "param_documented") && prose.has(a.tool)) continue;
    const key = assertionKey(a);
    if (seen.has(key)) continue;
    if (!holds(a, contract)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function fromStructural(change: StructuralChange, subpath: string): Assertion | null {
  const param = paramPath(change.target, change.tool);
  const base = { subpath, tool: change.tool };
  switch (change.rule) {
    case "tool_removed":
      return { ...base, kind: "tool_present", why: `removed in the version compared against` };
    case "param_removed":
      return param === null
        ? null
        : { ...base, kind: "param_present", param, why: `removed in the version compared against` };
    case "param_became_required":
      return param === null
        ? null
        : { ...base, kind: "param_optional", param, why: `became required in the version compared against` };
    case "param_became_optional":
      return param === null
        ? null
        : { ...base, kind: "param_required", param, why: `became optional in the version compared against` };
    case "param_type_changed":
      return param === null
        ? null
        : {
            ...base,
            kind: "param_type",
            param,
            expected: change.from,
            why: `changed type to ${String(change.to)} in the version compared against`,
          };
    case "enum_narrowed":
      return param === null || !Array.isArray(change.from)
        ? null
        : {
            ...base,
            kind: "enum_includes",
            param,
            expected: change.from,
            why: `these values were dropped from the enum in the version compared against`,
          };
    default:
      // `tool_added`, `param_added_*`, relaxed constraints and widened enums
      // describe something the newer version gained. There is nothing on this
      // side to pin: a test asserting the absence of a feature fails the moment
      // the consumer upgrades on purpose, which is not a defect.
      return null;
  }
}

function fromProse(finding: ProseFinding, subpath: string): Assertion | null {
  if (!EARNS_A_TEST.has(finding.confidence)) return null;
  const param = paramPath(finding.target, finding.tool);
  const base = { subpath, tool: finding.tool };
  switch (finding.rule) {
    case "guidance_removed":
    case "mode_switch_changed":
    case "example_removed": {
      const quote = finding.evidence.quote;
      if (quote === null || quote.trim().length === 0) return null;
      return {
        ...base,
        kind: "description_includes",
        expected: quote.trim(),
        why: `this sentence was deleted in the version compared against`,
      };
    }
    case "undocumented_optional":
      // Only pinnable when the older side actually documents it. Where both
      // sides leave the parameter unexplained there is nothing to protect, and
      // asserting otherwise writes a test that can never pass.
      return param === null
        ? null
        : {
            ...base,
            kind: "param_documented",
            param,
            why: `nothing explains when to pass this in the version compared against`,
          };
    default:
      return null;
  }
}

/**
 * Assertions from a comparison.
 *
 * Pins the older side — the contract the consumer depends on today — using the
 * findings to decide what is worth pinning. Everything the newer version merely
 * added is ignored: the point is to catch a loss, not to freeze a package.
 */
export function assertionsFromReport(report: Report): Assertion[] {
  const out: Assertion[] = [];
  for (const surface of report.surfaces) {
    if (!surface.from.present) continue;
    const contract = surface.from.contract;
    const proposed: Assertion[] = [];

    for (const change of surface.comparison.diff?.changes ?? []) {
      const a = fromStructural(change, surface.subpath);
      if (a !== null) proposed.push(a);
    }
    for (const finding of surface.prose.findings) {
      const a = fromProse(finding, surface.subpath);
      if (a !== null) proposed.push(a);
    }

    out.push(...accept(proposed, contract, surface.from.notes));
  }
  return out;
}

/**
 * Assertions that pin a whole contract, with no comparison involved.
 *
 * The tripwire case, and the more valuable of the two: run before any upgrade
 * is on the table, it records what the package offers today so that a future
 * release which quietly drops something fails the build instead of the product.
 *
 * Deliberately not exhaustive. Every tool and every parameter is pinned for
 * presence, and required-ness is pinned because changing it breaks callers in
 * both directions. Types, enums and prose are left alone: pinning those over a
 * whole contract produces hundreds of tests nobody reads, and volume is how a
 * generated suite gets switched off.
 */
export function assertionsFromContract(
  contract: Contract,
  subpath: string,
  notes: readonly ExtractionNote[] = [],
): Assertion[] {
  const proposed: Assertion[] = [];
  for (const tool of contract.tools) {
    proposed.push({
      kind: "tool_present",
      subpath,
      tool: tool.name,
      why: `this repository depends on the tool existing`,
    });
    for (const param of tool.params) {
      proposed.push({
        kind: "param_present",
        subpath,
        tool: tool.name,
        param: param.name,
        why: `this repository depends on the parameter existing`,
      });
      proposed.push({
        kind: param.required ? "param_required" : "param_optional",
        subpath,
        tool: tool.name,
        param: param.name,
        why: param.required
          ? `callers must still pass this`
          : `callers may still omit this`,
      });
    }
  }
  return accept(proposed, contract, notes);
}
