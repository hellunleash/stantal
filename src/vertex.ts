import { execFileSync, execSync } from "node:child_process";

/**
 * Gemini through Vertex AI instead of AI Studio.
 *
 * The two are the same models behind different billing. AI Studio
 * (`generativelanguage.googleapis.com`, an API key) is billed on its own;
 * Vertex (`aiplatform.googleapis.com`, an OAuth token) is billed to a Google
 * Cloud project, which is the only one of the two that draws on cloud credits.
 *
 * **This is a transport, never a provider.** The judge and caller ids are
 * `provider:model` and that id *is* the cache key, so routing the same model
 * through a different endpoint must not change it. Calling this `vertex:` would
 * strand every recording made under `gemini:` — same model, same prompt, same
 * answer, different id purely because of who gets the invoice. The existing
 * `STANTAL_JUDGE_TRANSPORT` switch sets the same precedent: it changes how a
 * request is sent and deliberately leaves identity alone.
 *
 * Verified against the live API on 2026-08-26: the request body and the
 * response shape are byte-for-byte what AI Studio takes and returns, so every
 * builder and reader is reused unchanged. Only the URL and the auth header
 * differ.
 */

export type VertexConfig = {
  project: string;
  /**
   * Defaults to `global`, and that default is load-bearing rather than lazy.
   * Measured: `us-central1` returns 404 for `gemini-3.6-flash` — the newer
   * models are not in every region, and a regional default would look like a
   * broken integration rather than a missing model.
   */
  location?: string;
};

export const DEFAULT_VERTEX_LOCATION = "global";

export function vertexFromEnv(env: NodeJS.ProcessEnv = process.env): VertexConfig | null {
  const project = env["STANTAL_VERTEX_PROJECT"];
  if (project === undefined || project.length === 0) return null;
  const location = env["STANTAL_VERTEX_LOCATION"];
  return { project, ...(location ? { location } : {}) };
}

export function vertexUrl(config: VertexConfig, model: string): string {
  const location = config.location ?? DEFAULT_VERTEX_LOCATION;
  // The global endpoint has no region prefix; a regional one does.
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return (
    `https://${host}/v1/projects/${encodeURIComponent(config.project)}` +
    `/locations/${encodeURIComponent(location)}/publishers/google/models/` +
    `${encodeURIComponent(model)}:generateContent`
  );
}

/**
 * An access token, from the environment or from `gcloud`.
 *
 * `GOOGLE_ACCESS_TOKEN` is checked first so a CI job can supply one from a
 * service account without this ever shelling out. Falling back to `gcloud` is
 * what makes it work on a developer machine with no extra setup, and it is why
 * no auth library is a dependency — the CLI has to stay light for a first
 * `npx`, and a Google auth client is a large thing to carry for a path most
 * runs never take.
 *
 * Cached, because the token is good for about an hour and shelling out costs
 * roughly a second. `clearVertexToken` exists for the 401 path: an expired
 * token is the expected failure on any run longer than that, and re-fetching
 * once is the difference between a backfill finishing and dying an hour in.
 */
let cachedToken: string | null = null;

export function clearVertexToken(): void {
  cachedToken = null;
}

export function vertexToken(env: NodeJS.ProcessEnv = process.env): string {
  const supplied = env["GOOGLE_ACCESS_TOKEN"];
  if (supplied !== undefined && supplied.length > 0) return supplied;
  if (cachedToken !== null) return cachedToken;

  const options: { encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"]; timeout: number } = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  };

  try {
    // Windows needs the shell, and neither obvious spelling works without it.
    // `gcloud` is extensionless and `execFileSync` does not apply PATHEXT, so
    // it raises ENOENT; `gcloud.cmd` resolves but Node refuses to spawn a
    // `.cmd` directly (EINVAL) as its fix for CVE-2024-27980. Both read as
    // "gcloud is not installed" on a machine where it is installed and
    // authenticated, which sends the user to repair something that is not
    // broken.
    //
    // `execSync` takes one command string, so no argument is ever concatenated
    // into a shell line — the command is this literal and nothing else reaches
    // it. That is what keeps the shell safe here, and it is why the arguments
    // are not passed separately with `shell: true`, which would be the same
    // call with an injection surface and a deprecation warning attached.
    const token = (
      process.platform === "win32"
        ? execSync("gcloud auth print-access-token", options)
        : execFileSync("gcloud", ["auth", "print-access-token"], options)
    ).trim();
    if (token.length === 0) throw new Error("gcloud returned an empty token");
    cachedToken = token;
    return token;
  } catch (error) {
    throw new Error(
      "Vertex needs an access token. Set GOOGLE_ACCESS_TOKEN, or install the " +
        "gcloud CLI and run `gcloud auth login`. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
