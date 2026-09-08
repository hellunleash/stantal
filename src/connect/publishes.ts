import { exportedSubpaths, fsPackageSource } from "../extract/package-source.js";
import { extractFromModule } from "../extract/module.js";

/**
 * Does this repository publish a package that hands a model tools?
 *
 * Asked so the briefing can tell a provider from a consumer. Every command in
 * this CLI except two answers a consumer's question — something I install is
 * about to move — and a repository that *publishes* a contract has the opposite
 * problem and a different set of commands for it. Briefing a provider entirely
 * about their dependencies is briefing them about the half of the product they
 * care about least.
 *
 * Answered by reading, never by asking. The same extractor that reads a
 * published tarball is pointed at this project's own build, so what it reports
 * is exactly what a consumer of this package would receive.
 *
 * **Both halves are required.** A package name alone means nothing — most
 * repositories have one. A tool set alone is not published. Only a repo that
 * has a name, is not marked private, and ships descriptors a consumer could
 * read is a provider, and being wrong about that puts a section in somebody's
 * `AGENTS.md` that has nothing to do with their project.
 */
export type ProviderFacts = {
  package: string;
  /** The entry points that actually ship tools. */
  subpaths: string[];
  tools: number;
};

export function publishesContract(directory: string): ProviderFacts | null {
  const source = fsPackageSource(directory);
  const manifest = source.packageJson();
  if (manifest === null) return null;

  const name = manifest["name"];
  if (typeof name !== "string" || name.length === 0) return null;
  // A private package is not published, so nobody downstream is calling it and
  // the provider's gate is not their question.
  if (manifest["private"] === true) return null;

  const version = typeof manifest["version"] === "string" ? manifest["version"] : "local";
  const subpaths: string[] = [];
  let tools = 0;
  for (const subpath of exportedSubpaths(manifest)) {
    // Reads the build on disk. A repo whose `dist` has not been built yet reads
    // as no contract, which is the right answer: that is also what a consumer
    // would get from a tarball packed in that state.
    const result = extractFromModule({ package: name, version, subpath, source });
    if (result.present && result.contract.tools.length > 0) {
      subpaths.push(subpath);
      tools += result.contract.tools.length;
    }
  }

  return subpaths.length === 0 ? null : { package: name, subpaths, tools };
}
