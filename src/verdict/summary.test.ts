import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { doctorPackage } from "../doctor.js";
import { doctorSummary, summaryLines } from "./summary.js";
import { RegistryError, type Registry } from "../registry/npm.js";
import { memoryRepoSource } from "../blast/repo.js";

function registryOf(latest: Record<string, string>, files: Record<string, Record<string, string>>): Registry {
  return {
    async versions(name) {
      const version = latest[name];
      if (version === undefined) throw new RegistryError(`no such package ${name}`);
      return [{ version, publishedAt: "2026-01-01T00:00:00.000Z", deprecated: null }];
    },
    async manifest(name) {
      const version = latest[name];
      if (version === undefined) throw new RegistryError(`no such package ${name}`);
      return { version, dependencies: {} };
    },
    async extract(name, version, destination) {
      const contents = files[`${name}@${version}`];
      if (contents === undefined) throw new RegistryError(`no such version ${name}@${version}`);
      for (const [path, body] of Object.entries(contents)) {
        const full = join(destination, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body, "utf8");
      }
    },
  };
}

function pack(name: string, tools: readonly string[]): Record<string, string> {
  const descriptors = tools.map(
    (tool) => `{
      name: ${JSON.stringify(tool)},
      description: "Build a screen from a request.",
      inputSchema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
    }`,
  );
  return {
    "package.json": JSON.stringify({ name, version: "0.0.0", exports: { ".": "./pack.js" } }),
    "pack.js": `export const tools = [${descriptors.join(", ")}];`,
  };
}

function project(name: string, version: string, range: string): string {
  const root = mkdtempSync(join(tmpdir(), "stantal-summary-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", dependencies: { [name]: range } }));
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  for (const [path, body] of Object.entries(pack(name, ["build"]))) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, path === "package.json" ? JSON.stringify({ ...JSON.parse(body), version }) : body, "utf8");
  }
  return root;
}

/**
 * The distinctive strings a leak would carry.
 *
 * Every one of these exists only on the consumer's machine: the directory, the
 * file, the line number, the line itself. If any of them reaches the payload,
 * the rule this file is built on has been broken.
 */
const SECRET_FILE = "src/internal-acquisition-agent.ts";
const SECRET_LINE = 'const PROJECT_CODENAME = "bluebird";';

async function summaryOf() {
  const root = project("@example/tools", "1.0.0", ">=1.0.0");
  const result = await doctorPackage({
    package: "@example/tools",
    directory: root,
    judge: null,
    cacheRoot: mkdtempSync(join(tmpdir(), "stantal-summary-cache-")),
    registry: registryOf(
      { "@example/tools": "1.1.0" },
      {
        "@example/tools@1.0.0": pack("@example/tools", ["build"]),
        "@example/tools@1.1.0": pack("@example/tools", ["assemble"]),
      },
    ),
    repo: memoryRepoSource({
      "package.json": JSON.stringify({ dependencies: { "@example/tools": ">=1.0.0" } }),
      [SECRET_FILE]: `import { tools } from "@example/tools";\n${SECRET_LINE}\nif (call.name === "build") run();\n`,
    }),
  });
  return { result, summary: doctorSummary(result, "9.9.9") };
}

describe("doctorSummary", () => {
  test("carries the provider's own names and the shape of the break", async () => {
    const { summary } = await summaryOf();
    expect(summary.package).toBe("@example/tools");
    expect(summary.from).toBe("1.0.0");
    expect(summary.to).toBe("1.1.0");
    expect(summary.verdict).toBe("structurally-breaking");
    expect(summary.breaks.map((b) => `${b.rule} ${b.target}`)).toContain("tool_removed build");
    expect(summary.breaks[0]?.reach).toBe("tool_reference");
    // The count of places, never the places.
    expect(summary.reaches).toBeGreaterThan(0);
  });

  /**
   * The test the whole file exists for. The doctor found a real break in a real
   * file, so the payload is at its most tempting here — and it still may not
   * carry one byte that came off this machine.
   */
  test("no path, line number, or line of the consumer's code survives", async () => {
    const { result, summary } = await summaryOf();

    // The directory as it appears once serialized. On Windows a path is full of
    // backslashes and `JSON.stringify` doubles every one, so comparing against
    // the raw string would pass without checking anything.
    const asWritten = JSON.stringify(result.directory).slice(1, -1);

    // The report it was built from really does carry all of it, so this is not
    // passing because there was nothing to leak.
    expect(JSON.stringify(result)).toContain(SECRET_FILE);
    expect(JSON.stringify(result)).toContain(asWritten);

    const wire = JSON.stringify(summary);
    expect(wire).not.toContain(SECRET_FILE);
    expect(wire).not.toContain(SECRET_LINE);
    expect(wire).not.toContain("internal-acquisition-agent");
    expect(wire).not.toContain("bluebird");
    expect(wire).not.toContain(asWritten);
    // The consumer's own package name is theirs, not the provider's.
    expect(wire).not.toContain("consumer");
    // A file reference ends in a line number. Checked over the string values
    // only: `places` is a number, and a test that just looked for a colon and
    // digits anywhere in the JSON would match it and pass for the wrong reason.
    // `subpath` really does hold "./ai-sdk" and "bin:name" — those are the
    // provider's own entry points and belong here.
    const strings = summary.breaks.flatMap((b) => [b.rule, b.target, b.subpath, b.reach]);
    expect(strings.every((v) => !/:\d+$/.test(v))).toBe(true);
  });

  /**
   * A rebuild, never a delete. This asserts the exact key set, so a field added
   * to `DoctorResult` later cannot arrive in the payload by being spread in —
   * it fails this test first, and somebody decides on purpose.
   */
  test("the payload is exactly these fields", async () => {
    const { summary } = await summaryOf();
    expect(Object.keys(summary).sort()).toEqual(
      [
        "breaks",
        "counts",
        "from",
        "generatedAt",
        "package",
        "reaches",
        "schema",
        "status",
        "to",
        "tool",
        "verdict",
      ].sort(),
    );
    expect(Object.keys(summary.breaks[0] ?? {}).sort()).toEqual(["places", "reach", "rule", "subpath", "target"]);
  });

  test("a repository the provider is not in sends a status, not a pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "stantal-summary-none-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", dependencies: {} }));
    const result = await doctorPackage({
      package: "@example/tools",
      directory: root,
      judge: null,
      registry: registryOf({}, {}),
    });
    const summary = doctorSummary(result, "9.9.9");
    expect(summary.status).toBe("not-a-dependency");
    // The number a provider must never be able to count as a clean install.
    expect(summary.verdict).toBe("not-applicable");
  });

  /**
   * The disclosure is rendered from the payload, so the two cannot describe
   * different things. A disclosure that is out of date is worse than none,
   * because it is believed.
   */
  test("the printed disclosure names the same counts the payload carries", async () => {
    const { summary } = await summaryOf();
    const text = summaryLines(summary).join("\n");
    expect(text).toContain(`${summary.breaks.length} on your tools`);
    expect(text).toContain(`${summary.reaches} place(s)`);
    expect(text).toContain("no file path, line number, or line of your code is included.");
    expect(text).not.toContain(SECRET_FILE);
  });
});
