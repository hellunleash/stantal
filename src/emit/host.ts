import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageDirectory } from "../testkit.js";

/**
 * Can this repository actually run what we are about to write into it?
 *
 * Added after a real install. `pin` wrote five TypeScript files into a Next.js
 * app that had no test runner, and the repository's own gate — `tsc --noEmit`,
 * with a tsconfig that globs `**\/*.ts` — went from exit 0 to exit 2 with ten
 * unresolved-import errors. The tool had broken the build of the project it was
 * supposed to protect, and said nothing about having added a dependency.
 *
 * Two failures, and they are different:
 *
 * 1. **The imports do not resolve.** The generated files reference `vitest` and
 *    `stantal/testkit`. If either is missing, every type-check in that repo
 *    fails from the moment we write, whether or not anyone runs a test.
 * 2. **Nothing will ever run them.** Plenty of app repos gate on type-checking
 *    and have no runner at all. A suite nobody runs cannot fail when an upgrade
 *    removes something, which is the entire reason it exists.
 *
 * Neither is a reason to refuse. They are reasons to say so, in the output,
 * with the exact command that fixes it.
 */

export type HostReadiness = {
  /** Packages the generated files import that this repository cannot resolve. */
  missing: string[];
  /** True when something here could actually execute the suite. */
  hasRunner: boolean;
  /** The npm script that would run them, when there is one. */
  testScript: string | null;
};

/** Packages every generated test file imports. */
export const REQUIRED_BY_TESTS = ["vitest", "stantal"] as const;

/** Runners we can recognise. Absence of a known one is reported, never guessed at. */
const RUNNERS = ["vitest", "jest", "mocha", "ava", "tap", "node:test"];

function manifestOf(directory: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * What this repository is missing, if anything.
 *
 * Resolution is by walking `node_modules`, the same way the generated tests
 * will resolve at run time — not by reading the manifest. A package listed in
 * `devDependencies` but never installed would pass a manifest check and still
 * fail every import.
 */
export function hostReadiness(directory: string): HostReadiness {
  const missing = REQUIRED_BY_TESTS.filter((name) => packageDirectory(name, directory) === null);

  const manifest = manifestOf(directory);
  const scripts = (manifest?.["scripts"] ?? {}) as Record<string, unknown>;
  const raw = typeof scripts["test"] === "string" ? scripts["test"] : null;

  // A `test` script that only prints an error is npm's own placeholder, and
  // treating it as a runner would report a suite as runnable when it is not.
  const placeholder = raw !== null && /no test specified/i.test(raw);
  const testScript = placeholder ? null : raw;

  // A runner counts if *any* script would invoke one, or if one is installed —
  // somebody may run `npx vitest` directly without a script for it. Any script
  // rather than `test` alone, because `pin` adds a `test:contract` of its own
  // and a project is free to name its suite whatever it likes.
  const scriptRuns = Object.values(scripts).some(
    (value) => typeof value === "string" && RUNNERS.some((r) => value.includes(r)),
  );
  const installed = RUNNERS.some((r) => r !== "node:test" && packageDirectory(r, directory) !== null);

  return { missing, hasRunner: scriptRuns || installed, testScript };
}

/**
 * What to tell the user, in the order it matters.
 *
 * Returns nothing when the repository is ready, so the happy path stays quiet.
 */
export function readinessNotes(readiness: HostReadiness, directory: string): string[] {
  const out: string[] = [];

  if (readiness.missing.length > 0) {
    out.push(`These files import ${readiness.missing.join(" and ")}, which this project cannot resolve.`);
    out.push(`Until you install them, a type-check here will fail:`);
    out.push("");
    out.push(`    npm install -D ${readiness.missing.join(" ")}`);
  }

  if (!readiness.hasRunner) {
    if (out.length > 0) out.push("");
    out.push(`Nothing in this project runs tests, so these will never execute — and a suite`);
    out.push(`that cannot fail is the one thing this was meant to avoid. Add a runner:`);
    out.push("");
    out.push(`    npm install -D vitest`);
    out.push(`    npm pkg set scripts.test="vitest run"`);
  } else if (readiness.testScript !== null) {
    if (out.length > 0) out.push("");
    out.push(`Run them with:  npm test`);
  }

  // A tsconfig that globs the whole tree will compile the generated folder
  // whether or not anybody asked it to. Worth naming, because the failure
  // shows up in a command that has nothing to do with testing.
  if (readiness.missing.length > 0 && existsSync(join(directory, "tsconfig.json"))) {
    out.push("");
    out.push(`This project type-checks TypeScript, so the failure will appear in your build`);
    out.push(`gate rather than in a test run.`);
  }

  return out;
}
