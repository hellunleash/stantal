import { describe, expect, test } from "vitest";
import type { SurfaceResult } from "../contract/surface.js";
import { EXTRACTOR_VERSION, type Contract } from "../contract/types.js";
import type { ProseFinding } from "../prose/taxonomy.js";
import type { Report, SurfaceReport, VerdictLevel } from "../report.js";
import { escapeHtml, renderHtml } from "./html.js";

function contract(): Contract {
  return {
    ecosystem: "npm",
    package: "@example/tools",
    version: "1.4.0",
    surface: "host-pack",
    extractedAt: "2026-01-01T00:00:00.000Z",
    extractorVersion: EXTRACTOR_VERSION,
    tools: [],
  };
}

const present: SurfaceResult = { present: true, contract: contract(), fidelity: "complete", notes: [] };

function finding(over: Partial<ProseFinding> = {}): ProseFinding {
  return {
    rule: "guidance_removed",
    target: "build.target",
    tool: "build",
    severity: "medium",
    basis: "deterministic",
    confidence: "certain",
    headline: "a sentence explaining when to pass `target` was deleted",
    evidence: {
      target: "build.target",
      before: null,
      after: null,
      quote: "Pass `target` only when overriding the default.",
      location: "dist/pack.js:12",
    },
    ...over,
  };
}

function report(over: Partial<Report> = {}, surface: Partial<SurfaceReport> = {}): Report {
  return {
    subject: { ecosystem: "npm", package: "@example/tools", from: "1.4.0", to: "1.5.0" },
    verdict: "prose-risk" as VerdictLevel,
    headline: "a sentence a model relied on is gone",
    surfaces: [
      {
        subpath: "./pack",
        from: present,
        to: present,
        comparison: { kind: "compared", diff: null, breaking: false, degraded: false, suppressed: [], note: "" },
        prose: { findings: [finding()], skipped: [], judge: "none" },
        behaviour: null,
        ...surface,
      },
    ],
    missingDependencies: [],
    judge: "none",
    caller: "none",
    blast: null,
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("the page is self-contained", () => {
  test("fetches nothing from anywhere", () => {
    // A verdict gets forwarded into places with no network, and read by people
    // who are right not to run what a stranger sent them. A page that phones
    // home when opened is one they should distrust.
    const html = renderHtml({ report: report() });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/i);
  });

  test("is a whole document", () => {
    const html = renderHtml({ report: report() });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("works in both colour schemes", () => {
    expect(renderHtml({ report: report() })).toContain("prefers-color-scheme:dark");
  });
});

describe("text out of a package is escaped", () => {
  test("a description containing markup cannot inject anything", () => {
    // Descriptions are arbitrary text from somebody else's package, and this
    // page gets forwarded. Pasting it in raw would make every verdict a way to
    // run script in the recipient's browser.
    const nasty = `<img src=x onerror="alert(1)">&"'`;
    const html = renderHtml({
      report: report({}, { prose: { findings: [finding({ headline: nasty })], skipped: [], judge: "none" } }),
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&quot;&#39;");
  });

  test("a quote with markup is escaped too", () => {
    const html = renderHtml({
      report: report(
        {},
        {
          prose: {
            findings: [finding({ evidence: { ...finding().evidence, quote: "</blockquote><script>x()</script>" } })],
            skipped: [],
            judge: "none",
          },
        },
      ),
    });
    expect(html).not.toContain("<script>");
  });

  test("the package name is escaped in the title", () => {
    const html = renderHtml({ report: report({ subject: { ecosystem: "npm", package: "<b>x</b>", from: "1", to: "2" } }) });
    expect(html).toContain("<title>&lt;b&gt;x&lt;/b&gt;");
  });

  test("escapeHtml covers every character that matters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("what the page shows", () => {
  test("the verdict, the subject and the headline", () => {
    const html = renderHtml({ report: report() });
    expect(html).toContain(`class="badge v-prose-risk"`);
    expect(html).toContain("@example/tools · 1.4.0 → 1.5.0");
    expect(html).toContain("a sentence a model relied on is gone");
  });

  test("the quote a finding rests on, beside it", () => {
    // The recipient is usually the person being told their package broke
    // something, and the first honest question is "show me".
    const html = renderHtml({ report: report() });
    expect(html).toContain("Pass `target` only when overriding the default.");
    expect(html).toContain("dist/pack.js:12");
  });

  test("withheld claims are printed, never dropped", () => {
    // "We could not tell" and "there was nothing" are opposite results. A page
    // showing only the second is the false confidence this project avoids.
    const html = renderHtml({
      report: report(
        {},
        {
          comparison: {
            kind: "compared",
            diff: null,
            breaking: false,
            degraded: true,
            suppressed: [{ rule: "tool_removed", target: "deploy", tool: "deploy", breaking: true, note: "" }],
            note: "",
          },
        },
      ),
    });
    expect(html).toContain("Withheld");
    expect(html).toContain("tool_removed");
  });

  test("says both packages were read, never run", () => {
    expect(renderHtml({ report: report() })).toContain("Neither package was executed");
  });

  test("an incomplete reach scan is not reported as a clean bill", () => {
    const html = renderHtml({
      report: report({
        blast: {
          reaches: [],
          filtered: [],
          notes: [{ code: "manifest_unreadable", detail: "no package.json", evidence: null }],
          filesScanned: 0,
        } as unknown as Report["blast"],
      }),
    });
    expect(html).toContain("not a clean bill");
  });

  test("a surface with nothing on it says so plainly", () => {
    const html = renderHtml({
      report: report({}, { prose: { findings: [], skipped: [], judge: "none" } }),
    });
    expect(html).toContain("Nothing found here.");
  });
});
