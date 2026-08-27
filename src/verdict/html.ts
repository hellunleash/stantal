import type { Report, SurfaceReport } from "../report.js";
import type { ProseFinding } from "../prose/taxonomy.js";
import type { StructuralChange } from "../diff/structural.js";

/**
 * The verdict as a page someone can send to someone else.
 *
 * Spec §8 asks for a forwardable artifact, and names a hosted URL. A URL needs
 * a server, a domain and an account, and none of those are needed for the part
 * that actually carries the value: a single file, readable in a browser, that
 * says what changed and what it rests on.
 *
 * **Self-contained on purpose.** No stylesheet, no script, no font, no image
 * fetched from anywhere. A verdict is forwarded into places with no network and
 * read by people who will not run something a stranger sent them, and a page
 * that phones home when opened is one those people are right to distrust.
 *
 * **Every claim shows its evidence.** The quote a finding rests on is printed
 * beside it, because the recipient is usually the person being told their
 * package broke something, and the first honest question is "show me".
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for HTML. Applied to every value that came out of a package. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const VERDICT_WORDS: Record<string, string> = {
  clean: "Nothing a model would read differently",
  "prose-risk": "Prose a model relies on has changed",
  "structurally-breaking": "The shape changed in a way that breaks callers",
  "behaviour-breaking": "A model was shown both and behaved differently",
  unreadable: "Too little could be read to say",
};

function badge(verdict: string): string {
  return `<span class="badge v-${escapeHtml(verdict)}">${escapeHtml(verdict)}</span>`;
}

function quote(text: string | null): string {
  if (text === null || text.trim().length === 0) return "";
  return `<blockquote>${escapeHtml(text.trim())}</blockquote>`;
}

function findingRow(finding: ProseFinding): string {
  const evidence = finding.evidence;
  const parts = [
    `<div class="item">`,
    `<div class="head">`,
    `<span class="sev s-${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>`,
    `<code>${escapeHtml(finding.rule)}</code>`,
    `<span class="target">${escapeHtml(finding.target)}</span>`,
    `<span class="conf">${escapeHtml(finding.confidence)}</span>`,
    `</div>`,
    `<p>${escapeHtml(finding.headline)}</p>`,
  ];
  // The quote is the whole reason a recipient believes any of this, so it is
  // shown by default rather than folded behind anything.
  if (evidence.quote !== null) parts.push(quote(evidence.quote));
  if (evidence.location !== null) parts.push(`<p class="where">${escapeHtml(evidence.location)}</p>`);
  parts.push(`</div>`);
  return parts.join("");
}

function changeRow(change: StructuralChange): string {
  return [
    `<div class="item">`,
    `<div class="head">`,
    `<span class="sev ${change.breaking ? "s-high" : "s-low"}">${change.breaking ? "breaking" : "change"}</span>`,
    `<code>${escapeHtml(change.rule)}</code>`,
    `<span class="target">${escapeHtml(change.target)}</span>`,
    `</div>`,
    change.note.length > 0 ? `<p>${escapeHtml(change.note)}</p>` : "",
    `</div>`,
  ].join("");
}

function surfaceSection(surface: SurfaceReport): string {
  const changes = (surface.comparison.diff?.changes ?? []).filter((c) => c.breaking);
  const findings = surface.prose.findings;
  const behaviour = surface.behaviour?.findings ?? [];
  const suppressed = surface.comparison.suppressed;
  const skipped = surface.prose.skipped;

  if (
    changes.length === 0 &&
    findings.length === 0 &&
    behaviour.length === 0 &&
    suppressed.length === 0 &&
    skipped.length === 0
  ) {
    return `<section><h2>${escapeHtml(surface.subpath)}</h2><p class="quiet">Nothing found here.</p></section>`;
  }

  const parts = [`<section><h2>${escapeHtml(surface.subpath)}</h2>`];
  for (const change of changes) parts.push(changeRow(change));
  for (const finding of findings) parts.push(findingRow(finding));
  for (const finding of behaviour) {
    parts.push(
      `<div class="item"><div class="head">` +
        `<span class="sev s-${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>` +
        `<code>${escapeHtml(finding.rule)}</code>` +
        `<span class="target">${escapeHtml(finding.target)}</span>` +
        `<span class="conf">${escapeHtml(finding.basis)}</span>` +
        `</div><p>${escapeHtml(finding.headline)}</p></div>`,
    );
  }

  // Withheld claims are printed, never dropped. "We could not tell" and "there
  // was nothing" are opposite results, and a page that shows only the second
  // is the false confidence this project exists to avoid.
  if (suppressed.length > 0 || skipped.length > 0) {
    parts.push(`<div class="withheld"><h3>Withheld</h3><p>Claims the reading could not support:</p><ul>`);
    for (const change of suppressed) {
      parts.push(`<li><code>${escapeHtml(change.rule)}</code> ${escapeHtml(change.target)}</li>`);
    }
    for (const item of skipped) {
      parts.push(`<li>${escapeHtml(item.target)} — ${escapeHtml(item.reason)}</li>`);
    }
    parts.push(`</ul></div>`);
  }

  parts.push(`</section>`);
  return parts.join("");
}

const STYLE = `
:root{--bg:#fff;--fg:#16181d;--dim:#5c6370;--line:#e3e6ea;--card:#f7f8fa;--accent:#5b3df5;
--high:#b3261e;--med:#8a5a00;--low:#43506b}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1115;--fg:#e6e8ec;
--dim:#98a0ae;--line:#252a33;--card:#161a21;--accent:#a48bff;--high:#ff6b5e;--med:#e0a33a;--low:#8b96ad}}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem;background:var(--bg);color:var(--fg);
font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:52rem;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .25rem}
h2{font-size:1rem;margin:2rem 0 .75rem;padding-bottom:.4rem;border-bottom:1px solid var(--line);
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);font-weight:600}
h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin:0 0 .4rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
.subject{color:var(--dim);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 1.25rem}
.badge{display:inline-block;padding:.2rem .6rem;border-radius:999px;font-weight:600;font-size:.8rem;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line)}
.v-clean{color:#0a7d33;border-color:#0a7d33}
.v-prose-risk,.v-unreadable{color:var(--med);border-color:var(--med)}
.v-structurally-breaking,.v-behaviour-breaking{color:var(--high);border-color:var(--high)}
.headline{font-size:1.05rem;margin:.75rem 0 0}
.item{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.85rem 1rem;margin:.6rem 0}
.head{display:flex;flex-wrap:wrap;gap:.6rem;align-items:baseline}
.sev{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.s-high{color:var(--high)}.s-medium{color:var(--med)}.s-low{color:var(--low)}
.target{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
.conf{margin-left:auto;font-size:.75rem;color:var(--dim)}
.item p{margin:.5rem 0 0;color:var(--dim)}
blockquote{margin:.6rem 0 0;padding:.5rem .8rem;border-left:3px solid var(--accent);
background:var(--bg);border-radius:0 4px 4px 0;font-size:.9rem;white-space:pre-wrap;overflow-x:auto}
.where{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem}
.withheld{margin-top:1rem;padding:.85rem 1rem;border:1px dashed var(--line);border-radius:8px}
.withheld ul{margin:.4rem 0 0;padding-left:1.1rem;color:var(--dim);font-size:.9rem}
.quiet{color:var(--dim)}
.reach{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--dim);font-size:.82rem}
table{border-collapse:collapse;width:100%;font-size:.88rem}
td{padding:.3rem .5rem .3rem 0;vertical-align:top}
`;

export type HtmlOptions = {
  report: Report;
  generator?: string;
};

/** Render a report as one self-contained HTML document. */
export function renderHtml(options: HtmlOptions): string {
  const { report } = options;
  const generator = options.generator ?? "stantal";
  const subject = `${report.subject.package} · ${report.subject.from} → ${report.subject.to}`;

  const body: string[] = [
    `<main>`,
    `<h1>${badge(report.verdict)}</h1>`,
    `<p class="subject">${escapeHtml(subject)}</p>`,
    `<p class="headline">${escapeHtml(report.headline || (VERDICT_WORDS[report.verdict] ?? ""))}</p>`,
  ];

  for (const surface of report.surfaces) body.push(surfaceSection(surface));

  if (report.blast !== null) {
    const reaches = report.blast.reaches;
    body.push(`<section><h2>Your code</h2>`);
    if (reaches.length === 0) {
      body.push(
        `<p class="quiet">${
          report.blast.notes.length === 0
            ? "Scanned, and none of this reaches your repository."
            : "No reach found — but the scan was incomplete, so this is not a clean bill."
        }</p>`,
      );
    } else {
      body.push(`<p class="quiet">Reaches your repository in ${reaches.length} place(s):</p><table>`);
      for (const reach of reaches) {
        body.push(
          `<tr><td class="reach">${escapeHtml(reach.evidence ?? "")}</td>` +
            `<td>${escapeHtml(reach.detail)}</td></tr>`,
        );
      }
      body.push(`</table>`);
    }
    body.push(`</section>`);
  }

  if (report.missingDependencies.length > 0) {
    body.push(
      `<section><h2>Not fetched</h2><p class="quiet">These narrowed what could be read: ` +
        `${escapeHtml(report.missingDependencies.join(", "))}</p></section>`,
    );
  }

  body.push(
    `<footer>`,
    `Generated by ${escapeHtml(generator)} on ${escapeHtml(report.generatedAt)}.<br>`,
    `Judge: ${escapeHtml(report.judge)} · Layer 2 caller: ${escapeHtml(report.caller)}.<br>`,
    `Contracts were read from the published files. Neither package was executed.`,
    `</footer>`,
    `</main>`,
  );

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(`${report.subject.package} ${report.subject.from} → ${report.subject.to}`)}</title>`,
    `<style>${STYLE}</style>`,
    `</head>`,
    `<body>`,
    body.join("\n"),
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}
