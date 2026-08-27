import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Contract, Param, Tool } from "./contract/types.js";
import { describeAbsence } from "./contract/surface.js";
import { extractFromModule } from "./extract/module.js";
import { fsPackageSource } from "./extract/package-source.js";
import { paramIsDocumented } from "./emit/taxonomy.js";

/**
 * The runtime for generated contract tests.
 *
 * Published as `stantal/testkit` and imported by every file the emitter writes.
 * It is deliberately tiny: four functions over plain data, so a generated test
 * reads as ordinary Vitest and a failure can be understood without knowing
 * anything about this project.
 *
 * **It never runs the package it reads.** The contract comes out of the
 * installed files statically, the same way every other extraction in this
 * codebase works. A test suite that executed its dependencies to inspect them
 * would be a worse thing to ship than the defect it is checking for.
 *
 * **It never reaches the network.** Whatever is installed is what gets read.
 * That is what makes the generated suite safe to run in CI on every commit.
 */

export type { Contract, Param, Tool } from "./contract/types.js";

export type LoadContractOptions = {
  package: string;
  /** The door being imported: "." by default, or e.g. "./ai-sdk". */
  subpath?: string;
  /**
   * Where to start looking for `node_modules`.
   *
   * Defaults to the working directory, which is the repository root under every
   * test runner. Set it when the tests live in a workspace package whose
   * dependencies are hoisted somewhere unusual.
   */
  from?: string;
};

/**
 * Walk up from `start` looking for `node_modules/<pkg>`.
 *
 * Node's own resolver is not used, and that is deliberate: `require.resolve`
 * answers "which file would an import of this specifier load", which fails
 * outright for a package that declares no main entry, and succeeds by returning
 * a path inside a *dependency* when a subpath is re-exported. Neither is the
 * question here, which is simply "where does this package live on disk".
 */
export function packageDirectory(pkg: string, start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function installedVersion(packageDir: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
    return typeof raw["version"] === "string" ? raw["version"] : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read the contract of an installed package.
 *
 * Throws rather than returning an empty contract when the package cannot be
 * found or its descriptors cannot be read. An empty contract would make every
 * assertion in the generated file fail at once, which reads as "the package
 * removed everything" — the exact false claim this project exists to avoid. A
 * thrown error names the real problem instead.
 */
export async function loadContract(options: LoadContractOptions): Promise<Contract> {
  const { package: pkg } = options;
  const subpath = options.subpath ?? ".";
  const dir = packageDirectory(pkg, options.from ?? process.cwd());
  if (dir === null) {
    throw new Error(
      `${pkg} is not installed under any node_modules above ${resolve(options.from ?? process.cwd())}. ` +
        `Contract tests read what is installed, so install it or point \`from\` at the right root.`,
    );
  }

  const result = extractFromModule({
    package: pkg,
    version: installedVersion(dir),
    subpath,
    source: fsPackageSource(dir),
  });

  if (!result.present) {
    throw new Error(
      `Could not read a contract for ${pkg} at "${subpath}": ${describeAbsence(result.absence)}. ` +
        `This is a gap in reading the package, not proof the tools are gone — ` +
        `check the subpath before treating it as a regression.`,
    );
  }

  return result.contract;
}

/** The tool under this name, or null. */
export function findTool(contract: Contract, name: string): Tool | null {
  return contract.tools.find((t) => t.name === name) ?? null;
}

/**
 * The parameter at this dotted path, or null.
 *
 * Accepts `limit` and `options.limit` alike, so a test can pin a member nested
 * inside an object parameter.
 */
export function findParam(contract: Contract, tool: string, path: string): Param | null {
  const found = findTool(contract, tool);
  if (found === null) return null;
  let current: Param[] = found.params;
  let param: Param | null = null;
  for (const segment of path.split(".")) {
    param = current.find((p) => p.name === segment) ?? null;
    if (param === null) return null;
    current = param.children ?? [];
  }
  return param;
}

/**
 * Does anything a model receives explain when to pass this parameter?
 *
 * A description on the parameter counts, and so does a sentence in the tool
 * description that refers to it *as a parameter* — a code span, a quoted name,
 * or a directive verb. A bare word match does not, because names like `app`,
 * `limit` and `context` occur as ordinary English in descriptions that never
 * explain the field at all.
 */
export function documentsParam(contract: Contract, tool: string, path: string): boolean {
  const found = findTool(contract, tool);
  const param = findParam(contract, tool, path);
  if (found === null || param === null) return false;
  return paramIsDocumented(found.description, param);
}
