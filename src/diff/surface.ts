import { isEvidencedAbsence, type ExtractionNote, type SurfaceResult } from "../contract/surface.js";
import { diffStructural, type StructuralChange, type StructuralDiff } from "./structural.js";

/**
 * Comparing two versions of one surface, when the surface may not exist at both.
 *
 * `diffStructural` assumes two contracts. That assumption breaks the moment a
 * release history is walked: an entry point gets introduced partway through, or
 * withdrawn, and feeding an empty contract into a structural diff reports every
 * tool as removed. The loudest possible finding, and false.
 *
 * So presence is decided first, and a structural diff is only produced when both
 * sides genuinely have a contract to compare.
 */

export type SurfaceComparisonKind =
  /** Both versions have this surface. `diff` is populated. */
  | "compared"
  /** Absent before, present now. There was no contract to break. */
  | "surface_introduced"
  /** Present before, absent now. A consumer's import stops resolving. */
  | "surface_withdrawn"
  /** Neither version has it. Nothing to say. */
  | "surface_absent"
  /** The two sides are not the same subject. Comparing them would be meaningless. */
  | "not_comparable";

export type SurfaceComparison = {
  kind: SurfaceComparisonKind;
  /** Structural changes, or null when presence made a comparison impossible. */
  diff: StructuralDiff | null;
  breaking: boolean;
  /**
   * True when extraction had gaps that could have hidden or invented a change.
   * A degraded comparison is still useful; it just cannot carry a claim that
   * something is absent from the package.
   */
  degraded: boolean;
  /** Changes withheld because extraction could not see the whole picture. */
  suppressed: StructuralChange[];
  note: string;
};

function notesOf(result: SurfaceResult): readonly ExtractionNote[] {
  return result.present ? result.notes : [];
}

/**
 * Which findings the extraction is not entitled to make.
 *
 * Two blind spots matter. If a descriptor's name could not be read, the tool set
 * is incomplete and no added/removed claim about tools is safe. If a tool's
 * schema could not be read, its parameters came back empty and every parameter
 * would otherwise read as removed.
 */
function suppression(from: SurfaceResult, to: SurfaceResult): {
  toolSetUnreliable: boolean;
  unreliableTools: Set<string>;
} {
  let toolSetUnreliable = false;
  const unreliableTools = new Set<string>();

  for (const note of [...notesOf(from), ...notesOf(to)]) {
    if (note.scope === "surface") toolSetUnreliable = true;
    if (note.scope === "schema" && note.target !== null) {
      // Targets are `tool` or `tool.path`; the tool is the part that matters.
      unreliableTools.add(note.target.split(".")[0] ?? note.target);
    }
  }

  return { toolSetUnreliable, unreliableTools };
}

const TOOL_PRESENCE_RULES = new Set(["tool_added", "tool_removed"]);

export function diffSurfaces(from: SurfaceResult, to: SurfaceResult): SurfaceComparison {
  const base = { diff: null, suppressed: [] as StructuralChange[] };

  // An absence we cannot stand behind is not evidence of anything. Comparing
  // against it would turn a failure to read into "the surface was withdrawn".
  for (const [side, result] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (!result.present && !isEvidencedAbsence(result.absence.reason)) {
      return {
        ...base,
        kind: "not_comparable",
        breaking: false,
        degraded: true,
        note:
          `extraction could not read the ${result.absence.surface} surface at ` +
          `${result.absence.version} (${side}: ${result.absence.reason}). ` +
          `That is a gap in the reading, not a finding about the package.`,
      };
    }
  }

  if (!from.present && !to.present) {
    return {
      ...base,
      kind: "surface_absent",
      breaking: false,
      degraded: false,
      note: `neither version exposes the ${from.absence.surface} surface`,
    };
  }

  if (!from.present && to.present) {
    return {
      ...base,
      kind: "surface_introduced",
      breaking: false,
      degraded: to.fidelity === "partial",
      note:
        `the ${to.contract.surface} surface does not exist at ${from.absence.version} ` +
        `(${from.absence.reason}); ${to.contract.tools.length} tool(s) appear at ${to.contract.version}. ` +
        `There is no earlier contract to compare against.`,
    };
  }

  if (from.present && !to.present) {
    return {
      ...base,
      kind: "surface_withdrawn",
      // A consumer importing this entry point stops resolving. That is breaking
      // in the plainest sense, and it is the one absence case that is.
      breaking: true,
      degraded: from.fidelity === "partial",
      note:
        `the ${from.contract.surface} surface existed at ${from.contract.version} with ` +
        `${from.contract.tools.length} tool(s) and is gone at ${to.absence.version} (${to.absence.reason})`,
    };
  }

  if (!from.present || !to.present) return { ...base, kind: "not_comparable", breaking: false, degraded: false, note: "unreachable" };

  const a = from.contract;
  const b = to.contract;

  if (a.surface !== b.surface) {
    return {
      ...base,
      kind: "not_comparable",
      breaking: false,
      degraded: false,
      note: `refusing to compare a ${a.surface} contract with a ${b.surface} one: different doors are different contracts`,
    };
  }

  if (a.package !== b.package || a.ecosystem !== b.ecosystem) {
    return {
      ...base,
      kind: "not_comparable",
      breaking: false,
      degraded: false,
      note: `refusing to compare ${a.ecosystem}/${a.package} with ${b.ecosystem}/${b.package}`,
    };
  }

  const full = diffStructural(a, b);
  const { toolSetUnreliable, unreliableTools } = suppression(from, to);

  const kept: StructuralChange[] = [];
  const suppressed: StructuralChange[] = [];
  for (const change of full.changes) {
    const hidden =
      (toolSetUnreliable && TOOL_PRESENCE_RULES.has(change.rule)) || unreliableTools.has(change.tool);
    (hidden ? suppressed : kept).push(change);
  }

  const degraded = suppressed.length > 0 || from.fidelity === "partial" || to.fidelity === "partial";

  return {
    kind: "compared",
    diff: {
      changes: kept,
      breaking: kept.some((c) => c.breaking),
      changedTools: [...new Set(kept.map((c) => c.tool))].sort(),
    },
    breaking: kept.some((c) => c.breaking),
    degraded,
    suppressed,
    note:
      suppressed.length === 0
        ? `${kept.length} structural change(s)`
        : `${kept.length} structural change(s); ${suppressed.length} withheld because extraction could not read the whole contract`,
  };
}
