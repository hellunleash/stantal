import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Storage } from "@google-cloud/storage";
import { renderHtml } from "stantal";

/**
 * The verdict host.
 *
 * One job: take a report, render it, and give back a URL somebody can send to
 * the author of the package that broke their product. Spec §8 — the forwardable
 * artifact, and the only part of this product that has to be hosted.
 *
 * **It renders; it does not accept HTML.** Taking a finished page and serving
 * it would turn this into free hosting for whatever anyone uploads, on our
 * domain, with our name on it. Accepting only a report and rendering it here
 * means the only pages that can exist are verdicts.
 *
 * **Content-addressed.** The id is a hash of the report, so publishing the same
 * verdict twice returns the same URL instead of littering, and no database is
 * needed to know what exists.
 *
 * **Nothing here is required to get a verdict.** The CLI produces the same page
 * locally with `--html`. This exists so a page can be forwarded, not so a
 * verdict can be reached.
 */

const BUCKET = process.env.VERDICT_BUCKET ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "";

/** Well under Cloud Run's request cap, and far above any real report. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Read once at startup. The landing page is the same on every request, and
// re-reading it per request would trade a cold start for a disk hit forever.
const HERE = dirname(fileURLToPath(import.meta.url));
let LANDING = "";
try {
  LANDING = readFileSync(join(HERE, "landing.html"), "utf8");
} catch {
  LANDING = "";
}

const storage = new Storage();
const bucket = BUCKET.length > 0 ? storage.bucket(BUCKET) : null;

/**
 * Does this look like a report we produced?
 *
 * Deliberately structural rather than a full schema check. It has to reject
 * anything that is not a verdict — which is what stops this becoming an open
 * upload endpoint — without rejecting a report from a slightly older or newer
 * release of the CLI, since those are exactly the clients that will call it.
 */
function validate(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "body is not an object";

  const subject = value.subject;
  if (subject === null || typeof subject !== "object") return "missing subject";
  for (const field of ["package", "from", "to"]) {
    if (typeof subject[field] !== "string" || subject[field].length === 0) return `subject.${field} is missing`;
  }

  const verdicts = ["clean", "prose-risk", "structurally-breaking", "behaviour-breaking", "unreadable"];
  if (!verdicts.includes(value.verdict)) return "verdict is not one of the known values";
  if (!Array.isArray(value.surfaces)) return "surfaces is not an array";
  if (typeof value.headline !== "string") return "headline is missing";

  // Refused rather than stripped. A client that sends local file paths has a
  // bug or an old build, and quietly accepting it would hide that from the one
  // person who could fix it.
  if (value.blast !== null && value.blast !== undefined) {
    return "blast must be null — a published verdict never carries paths from a private repository";
  }
  return null;
}

function idFor(report) {
  // Keyed on the report as sent. Two identical verdicts collapse to one URL;
  // any difference, including the timestamp, makes a new one.
  return createHash("sha256").update(JSON.stringify(report)).digest("hex").slice(0, 16);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, body, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  response.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "content-length": Buffer.byteLength(payload),
    // A verdict page is one thing and must never be able to reach anywhere
    // else. It is generated from a report, but the report came from a stranger.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(payload);
}

async function handlePublish(request, response) {
  if (bucket === null) return send(response, 500, { error: "VERDICT_BUCKET is not configured" });

  let parsed;
  try {
    parsed = JSON.parse(await readBody(request));
  } catch (error) {
    return send(response, 400, { error: `could not read the body: ${error.message}` });
  }

  const report = parsed?.report ?? parsed;
  const invalid = validate(report);
  if (invalid !== null) return send(response, 400, { error: invalid });

  const id = idFor(report);
  const html = renderHtml({ report, generator: "stantal" });

  await Promise.all([
    bucket.file(`v/${id}.html`).save(html, { contentType: "text/html; charset=utf-8" }),
    bucket.file(`v/${id}.json`).save(JSON.stringify(report), { contentType: "application/json" }),
  ]);

  const origin = PUBLIC_ORIGIN.length > 0 ? PUBLIC_ORIGIN : `http://localhost:${PORT}`;
  return send(response, 201, { id, url: `${origin}/v/${id}` });
}

async function handleRead(id, response) {
  if (bucket === null) return send(response, 500, { error: "VERDICT_BUCKET is not configured" });
  if (!/^[0-9a-f]{16}$/.test(id)) return send(response, 400, { error: "not a verdict id" });

  try {
    const [contents] = await bucket.file(`v/${id}.html`).download();
    return send(response, 200, contents.toString("utf8"), "text/html");
  } catch {
    return send(response, 404, { error: "no such verdict" });
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  // Not /healthz: Cloud Run's frontend answers that path itself and the request
  // never reaches the container, which reads as a service that is down.
  if (request.method === "GET" && url.pathname === "/status") {
    return send(response, 200, { ok: true, bucket: BUCKET.length > 0 });
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    if (LANDING.length === 0) return send(response, 404, { error: "not found" });
    return send(response, 200, LANDING, "text/html");
  }
  if (request.method === "POST" && url.pathname === "/v") {
    return handlePublish(request, response).catch((error) =>
      send(response, 500, { error: error.message }),
    );
  }
  const match = /^\/v\/([0-9a-f]{1,64})$/.exec(url.pathname);
  if (request.method === "GET" && match !== null) {
    return handleRead(match[1], response).catch((error) => send(response, 500, { error: error.message }));
  }
  return send(response, 404, { error: "not found" });
});

server.listen(PORT, () => {
  process.stdout.write(`verdict host listening on ${PORT}, bucket=${BUCKET || "(unset)"}\n`);
});
