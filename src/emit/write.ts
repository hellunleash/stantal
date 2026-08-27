import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assertion } from "./taxonomy.js";
import { renderVitest, testFileName } from "./vitest.js";

/**
 * Writing the emitted suite to disk.
 *
 * Split from the renderer so the whole emit path is testable without touching a
 * filesystem, and so the one place that writes into somebody else's repository
 * is small enough to read in a sitting.
 */

export type EmitTarget = {
  package: string;
  subpath: string;
  assertions: Assertion[];
  version?: string;
};

export type WrittenFile = {
  path: string;
  subpath: string;
  assertions: number;
};

export type EmitOptions = {
  directory: string;
  targets: readonly EmitTarget[];
  generator?: string;
  generatedAt?: string;
  /** Render without touching disk. Used by the CLI's preview and by tests. */
  dryRun?: boolean;
};

/**
 * One file per door, never one file per package.
 *
 * Two subpaths of the same package are two different contracts, read
 * separately and free to disagree. A single file would need two `loadContract`
 * calls and a reader would have to track which assertions belonged to which —
 * and a failure would not say which import is affected, which is the first
 * thing anyone needs to know.
 *
 * Doors with nothing to pin are skipped rather than written empty. An empty
 * file in a test directory reads as coverage, and reading it as coverage is
 * exactly the mistake this project spends the rest of its code avoiding.
 */
export function emitTests(options: EmitOptions): WrittenFile[] {
  const { directory, targets } = options;
  const written: WrittenFile[] = [];
  const usable = targets.filter((t) => t.assertions.length > 0);
  if (usable.length === 0) return written;

  if (options.dryRun !== true) mkdirSync(directory, { recursive: true });

  for (const target of usable) {
    const name = testFileName(target.package, target.subpath);
    const path = join(directory, name);
    const contents = renderVitest({
      package: target.package,
      subpath: target.subpath,
      assertions: target.assertions,
      ...(target.version === undefined ? {} : { version: target.version }),
      ...(options.generator === undefined ? {} : { generator: options.generator }),
      ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    });
    if (options.dryRun !== true) writeFileSync(path, contents, "utf8");
    written.push({ path, subpath: target.subpath, assertions: target.assertions.length });
  }

  return written;
}
