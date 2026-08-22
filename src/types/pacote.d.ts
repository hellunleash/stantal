/**
 * Minimal declarations for the part of pacote this project uses.
 *
 * pacote ships no types. Declaring only the three calls we make keeps the
 * surface we depend on visible, and makes swapping the fetcher a small change
 * rather than an archaeology exercise.
 */
declare module "pacote" {
  export type PacoteOptions = {
    registry?: string;
    cache?: string;
    fullMetadata?: boolean;
    before?: Date;
    [key: string]: unknown;
  };

  export type Packument = {
    name: string;
    "dist-tags"?: Record<string, string>;
    versions: Record<string, { version: string; deprecated?: string }>;
    /** Publish timestamps by version, plus `created` and `modified`. */
    time?: Record<string, string>;
  };

  export type Manifest = {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    [key: string]: unknown;
  };

  // pacote is CommonJS, and Node's ESM interop does not expose its functions as
  // named exports. The default export is `module.exports`, so it is declared
  // that way rather than as named functions.
  const pacote: {
    packument(spec: string, opts?: PacoteOptions): Promise<Packument>;
    manifest(spec: string, opts?: PacoteOptions): Promise<Manifest>;
    extract(
      spec: string,
      destination: string,
      opts?: PacoteOptions,
    ): Promise<{ resolved?: string; integrity?: string }>;
  };

  export default pacote;
}
