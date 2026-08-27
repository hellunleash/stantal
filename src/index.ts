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

export type { Report, SurfaceReport, VerdictLevel } from "./report.js";
export { buildLocalReport, buildManifestReport, buildReport, exitCodeFor } from "./report.js";

export type { HistoryResult, Onset } from "./history.js";
export { walkHistory } from "./history.js";

export { planRemedy } from "./remedy/plan.js";
export { blastRadius } from "./blast/scan.js";
export { assertionsFromContract, assertionsFromReport } from "./emit/assertions.js";
export { emitTests } from "./emit/write.js";
export { renderVitest, testFileName } from "./emit/vitest.js";
export { renderHtml } from "./verdict/html.js";
export { publishableReport } from "./verdict/publish.js";
