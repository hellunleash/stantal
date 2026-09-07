import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The step that makes a restoration survive `npm install`.
 *
 * `--emit-patch` writes a reviewable diff, and a diff nothing reapplies is a
 * fix that disappears on the next install exactly as quietly as the sentence it
 * restores. `patch-package` is what reapplies it, driven by a `postinstall`
 * script. Until now the command printed the two lines and left them to be typed.
 *
 * **It writes one field.** Not the dependency: adding `patch-package` to
 * somebody's manifest means choosing a version range, and a range nobody
 * checked is a version claim this tool has no basis for. The install command is
 * printed instead, which is a line a person runs deliberately.
 */

export type WireOutcome =
  /** `scripts.postinstall` was empty and now runs patch-package. */
  | { kind: "wired"; detail: string }
  /** Already runs it. Nothing to do, and saying so beats writing the same thing twice. */
  | { kind: "already"; detail: string }
  /**
   * A postinstall script is already here and does something else.
   *
   * Refused rather than chained. A postinstall runs on every install on every
   * machine, and appending to somebody's build step on their behalf is a much
   * larger change than writing a patch file. The line to add is printed.
   */
  | { kind: "refused"; detail: string };

type Manifest = { scripts?: Record<string, unknown> } & Record<string, unknown>;

/** What wiring this project would do, without doing it. */
export function planReapply(manifest: Manifest): WireOutcome {
  const scripts = (typeof manifest["scripts"] === "object" && manifest["scripts"] !== null
    ? manifest["scripts"]
    : {}) as Record<string, unknown>;
  const existing = scripts["postinstall"];

  if (typeof existing === "string" && existing.includes("patch-package")) {
    return { kind: "already", detail: `postinstall already runs patch-package: "${existing}"` };
  }
  if (typeof existing === "string" && existing.trim().length > 0) {
    return {
      kind: "refused",
      detail: `postinstall is already "${existing}" — add patch-package to it yourself rather than have us rewrite your build step`,
    };
  }
  return { kind: "wired", detail: 'set scripts.postinstall to "patch-package"' };
}

/**
 * Write the hook into the project's manifest.
 *
 * Re-serialized with two-space indentation, which is what npm itself writes.
 * Nothing else in the file is touched: the object is read, one field is set,
 * and key order is preserved by `JSON.parse`/`JSON.stringify`.
 */
export function wireReapply(root: string): WireOutcome {
  const path = join(root, "package.json");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch (error) {
    return {
      kind: "refused",
      detail: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const outcome = planReapply(manifest);
  if (outcome.kind !== "wired") return outcome;

  const scripts = (typeof manifest["scripts"] === "object" && manifest["scripts"] !== null
    ? manifest["scripts"]
    : {}) as Record<string, unknown>;
  manifest["scripts"] = { ...scripts, postinstall: "patch-package" };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outcome;
}
