/**
 * The public library surface.
 *
 * Kept deliberately narrow. The CLI is the product and everything under `src`
 * is free to move; what is re-exported here is what someone may build against,
 * so every addition is a promise. The generated-test runtime is *not* here — it
 * ships as `stantal/testkit`, because a test file should pull in a contract
 * reader and nothing else.
 */

export type {
  Constraints,
  Contract,
  Ecosystem,
  JsonType,
  Param,
  Surface,
  Tool,
} from "./contract/types.js";

export type {
  ExtractionNote,
  Fidelity,
  NoteScope,
  SurfaceAbsence,
  SurfaceResult,
} from "./contract/surface.js";
export { isPresent } from "./contract/surface.js";

export type { StructuralChange, StructuralDiff, StructuralRule } from "./diff/structural.js";
export type { SurfaceComparison } from "./diff/surface.js";
export type { Basis, Confidence, ProseFinding, ProseRule, Severity } from "./prose/taxonomy.js";
export type { BlastResult, Reach, ReachKind } from "./blast/taxonomy.js";
export type { Hold, Remedy, RemedyKind } from "./remedy/taxonomy.js";
export type { Assertion, AssertionKind } from "./emit/taxonomy.js";

export type { ConfirmedBreak, Report, SurfaceReport, VerdictLevel } from "./report.js";
export {
  buildLocalReport,
  buildManifestReport,
  buildReport,
  buildSurfacePairReport,
  exitCodeFor,
} from "./report.js";

/**
 * The provider path, exported because embedding it is the point.
 *
 * `doctor` exists so a provider can put this check inside their own CLI. Doing
 * that by shelling out to `npx stantal doctor` and parsing the output would be
 * a worse version of calling the function, and a provider who has to parse our
 * stdout is one release away from us breaking them — which is, precisely, the
 * thing this project is about.
 */
export type { DoctorOptions, DoctorResult, DoctorStatus } from "./doctor.js";
export { doctorPackage, doctorVerdict } from "./doctor.js";

/**
 * The bounded payload, and the words printed before it is sent.
 *
 * A provider who wants their own receiver rather than ours needs the builder,
 * not a copy of its rules. One implementation means their payload and ours
 * cannot disagree about what is allowed to leave a user's machine.
 */
export type { BreakShape, DoctorSummary } from "./verdict/summary.js";
export { doctorSummary, summaryLines } from "./verdict/summary.js";

/** Reading a server that is running rather than a package that is published. */
export type { LiveOptions, LiveTarget } from "./extract/live.js";
export { labelFor, parseTarget, readLiveServer } from "./extract/live.js";

/** The census half of the provider's number: a walk crossed with public downloads. */
export type { ExposureResult, ExposureRow, ExposureState } from "./exposure.js";
export { exposureOf, fetchDownloads } from "./exposure.js";

export type { HistoryResult, Onset } from "./history.js";
export { walkHistory } from "./history.js";

export { planRemedy } from "./remedy/plan.js";
export { blastRadius } from "./blast/scan.js";
export { assertionsFromContract, assertionsFromReport } from "./emit/assertions.js";
export { emitTests } from "./emit/write.js";
export { renderVitest, testFileName } from "./emit/vitest.js";
export { renderHtml } from "./verdict/html.js";
export { publishableReport } from "./verdict/publish.js";
