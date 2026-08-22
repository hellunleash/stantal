import pacote from "pacote";
import type { PacoteOptions, Packument } from "pacote";

/**
 * The npm registry, behind an interface.
 *
 * Two reasons it is an interface rather than direct calls. Tests must run
 * offline, and the paid product runs inside a provider's own CI against a
 * private registry — so auth, proxies and `.npmrc` have to be somebody else's
 * problem. That is why the default implementation is pacote: it is what npm
 * itself uses, so private registries work without a line of code here.
 */

export type VersionInfo = {
  version: string;
  /** ISO timestamp from the registry, or null when it publishes none. */
  publishedAt: string | null;
  deprecated: string | null;
};

export type ResolvedManifest = {
  version: string;
  dependencies: Record<string, string>;
};

export interface Registry {
  /** Every published version, oldest first. This is what a release-history walk reads. */
  versions(name: string): Promise<VersionInfo[]>;
  /** Resolve a range like "^1.2.0" to the exact version a consumer would get. */
  manifest(name: string, spec: string): Promise<ResolvedManifest>;
  /** Unpack one exact version into a directory. Unpacking only — nothing is run. */
  extract(name: string, version: string, destination: string): Promise<void>;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Package names, as the registry allows them.
 *
 * Checked because the spec string is handed to a fetcher that understands far
 * more than registry versions. A git or file spec would make it run the
 * package's `prepare` script, which is exactly the thing this project never
 * does. Refusing anything that is not a plain name is the guard.
 */
const NAME = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/;
/** Exact versions only. A range here would silently resolve to something else. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export function assertRegistrySpec(name: string, version: string): void {
  if (!NAME.test(name)) {
    throw new RegistryError(`refusing to fetch "${name}": not a plain registry package name`);
  }
  if (!EXACT_VERSION.test(version)) {
    throw new RegistryError(`refusing to fetch ${name}@${version}: an exact version is required`);
  }
}

export type PacoteRegistryOptions = {
  /** Overrides the registry URL. Left unset, pacote reads the user's npm config. */
  registry?: string;
  /** Where pacote keeps its own HTTP cache. */
  cache?: string;
  /** Resolve ranges as they stood at this moment, not as they stand today. */
  before?: Date;
};

export function pacoteRegistry(options: PacoteRegistryOptions = {}): Registry {
  const base: PacoteOptions = {
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.before !== undefined ? { before: options.before } : {}),
  };

  return {
    async versions(name) {
      if (!NAME.test(name)) throw new RegistryError(`"${name}" is not a plain registry package name`);
      let packument: Packument;
      try {
        packument = await pacote.packument(name, base);
      } catch (error) {
        throw new RegistryError(`could not read the release history of ${name}`, error);
      }

      const times = packument.time ?? {};
      return Object.values(packument.versions)
        .map((entry) => ({
          version: entry.version,
          publishedAt: times[entry.version] ?? null,
          deprecated: entry.deprecated ?? null,
        }))
        // Chronological, because "which release introduced this" is a question
        // about publish order. Semver order answers a different question and
        // disagrees whenever a patch lands on an older line.
        .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
    },

    async manifest(name, spec) {
      if (!NAME.test(name)) throw new RegistryError(`"${name}" is not a plain registry package name`);
      try {
        const resolved = await pacote.manifest(`${name}@${spec}`, base);
        return { version: resolved.version, dependencies: resolved.dependencies ?? {} };
      } catch (error) {
        throw new RegistryError(`could not resolve ${name}@${spec}`, error);
      }
    },

    async extract(name, version, destination) {
      assertRegistrySpec(name, version);
      try {
        await pacote.extract(`${name}@${version}`, destination, base);
      } catch (error) {
        throw new RegistryError(`could not unpack ${name}@${version}`, error);
      }
    },
  };
}
