import type { Contract, Ecosystem, Surface } from "./types.js";

/**
 * The result of asking a version for one surface.
 *
 * A surface is not guaranteed to exist at every version. A pack entry point can
 * be introduced halfway through a release history, or withdrawn. So "there is no
 * contract here" has to be a first-class answer, not an empty contract — an
 * empty contract compares as "every tool was removed", which is a false and very
 * loud finding.
 */

export type SurfaceAbsenceReason =
  /** The package ships no manifest we can read. */
  | "no_package_json"
  /** The package does not offer this entry point. The surface genuinely is not here. */
  | "not_exported"
  /** The manifest points at a file the package did not ship. */
  | "file_missing"
  /** The file is there but is not parseable as JavaScript. */
  | "unparseable"
  /**
   * The file parsed and held no tool descriptor at all. Reported as absent
   * rather than as a contract with zero tools, because "we found none" and
   * "there are none" are different claims and only one of them is evidenced.
   */
  | "no_descriptors"
  /**
   * Descriptors are there and none of them could be read — every tool named by
   * an expression this extractor cannot fold. Kept apart from `no_descriptors`
   * on purpose: this surface exists, and saying it does not would be a false
   * finding of exactly the kind the product is supposed to catch.
   */
  | "descriptors_unreadable";

export type SurfaceAbsence = {
  ecosystem: Ecosystem;
  package: string;
  version: string;
  surface: Surface;
  reason: SurfaceAbsenceReason;
  detail: string;
  /** What was looked for, so the answer can be checked. */
  checked: string[];
};

/**
 * What part of the contract an extraction gap covers.
 *
 * The scope is the useful field, not the message: it is what lets a later layer
 * decide which findings it is entitled to make.
 */
export type NoteScope =
  /** The set of tools itself may be incomplete. Nothing about presence is safe. */
  | "surface"
  /** One tool's parameters could not be read. Nothing below that tool is safe. */
  | "schema"
  /** Prose could not be read. A missing description here is our gap, not theirs. */
  | "description";

export type ExtractionNoteCode =
  | "descriptor_name_unresolved"
  | "descriptor_schema_unresolved"
  | "description_unresolved"
  | "duplicate_descriptor";

export type ExtractionNote = {
  code: ExtractionNoteCode;
  scope: NoteScope;
  /** Tool name, or `tool.param`. null when even the name is unknown. */
  target: string | null;
  /** `file.js:300` — the line a reader can open to check the claim. */
  evidence: string | null;
  detail: string;
};

/**
 * Whether an absence is a fact about the package or a limit of our reading.
 *
 * The distinction decides what may be said out loud. An evidenced absence
 * supports "this version does not have this surface". An unevidenced one
 * supports nothing at all, and must never be compared as though it were empty.
 */
const EVIDENCED_ABSENCE: Record<SurfaceAbsenceReason, boolean> = {
  no_package_json: true,
  not_exported: true,
  file_missing: true,
  no_descriptors: true,
  unparseable: false,
  descriptors_unreadable: false,
};

export function isEvidencedAbsence(reason: SurfaceAbsenceReason): boolean {
  return EVIDENCED_ABSENCE[reason];
}

/**
 * `complete` means every descriptor was read whole. Only a complete extraction
 * can support a claim of the form "the package ships nothing here".
 */
export type Fidelity = "complete" | "partial";

export type SurfaceResult =
  | { present: true; contract: Contract; fidelity: Fidelity; notes: ExtractionNote[] }
  | { present: false; absence: SurfaceAbsence };

export function fidelityOf(notes: readonly ExtractionNote[]): Fidelity {
  return notes.length === 0 ? "complete" : "partial";
}

export function isPresent(
  result: SurfaceResult,
): result is { present: true; contract: Contract; fidelity: Fidelity; notes: ExtractionNote[] } {
  return result.present;
}

/** Human line for a surface that is not there. Used in the verdict and in the CLI. */
export function describeAbsence(absence: SurfaceAbsence): string {
  return `${absence.package}@${absence.version} has no ${absence.surface} surface (${absence.reason}): ${absence.detail}`;
}
