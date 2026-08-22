import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { walkHistory } from "./history.js";
import { RegistryError, type Registry } from "./registry/npm.js";

/** Offline. The fake registry writes the files a real unpack would. */
function registryOf(versions: Record<string, Record<string, string>>): Registry {
  const order = Object.keys(versions);
  return {
    async versions() {
      return order.map((version, index) => ({
        version,
        publishedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        deprecated: null,
      }));
    },
    async manifest(name, spec) {
      return { version: spec.replace(/^[\^~]/, ""), dependencies: {} };
    },
    async extract(_name, version, destination) {
      const files = versions[version];
      if (files === undefined) throw new RegistryError(`no such version ${version}`);
      for (const [path, contents] of Object.entries(files)) {
        const full = join(destination, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, contents, "utf8");
      }
    },
  };
}

const MANIFEST = JSON.stringify({ name: "@example/tools", exports: { "./pack": "./pack.js" } });

/** A pack whose `build` tool takes exactly these optional parameters. */
function release(description: string, optional: readonly string[]): Record<string, string> {
  const properties = ["request: { type: \"string\" }", ...optional.map((p) => `${p}: { type: "string" }`)];
  return {
    "package.json": MANIFEST,
    "pack.js": `export const tools = [{
      name: "build",
      description: ${JSON.stringify(description)},
      inputSchema: { type: "object", properties: { ${properties.join(", ")} }, required: ["request"] },
    }];`,
  };
}

const PLAIN = "Build a screen from a request.";
const DOCUMENTED = "Build a screen from a request. Pass `target` only when changing an existing one.";

async function walk(versions: Record<string, Record<string, string>>, extra: Record<string, unknown> = {}) {
  return walkHistory({
    package: "@example/tools",
    registry: registryOf(versions),
    cacheRoot: mkdtempSync(join(tmpdir(), "stantal-history-")),
    subpaths: ["./pack"],
    concurrency: 2,
    ...extra,
  });
}

describe("walkHistory", () => {
  test("pins the release that introduced a finding, and the last one before it", async () => {
    const result = await walk({
      "1.0.0": release(PLAIN, []),
      "1.1.0": release(PLAIN, []),
      "1.2.0": release(PLAIN, ["target"]),
      "1.3.0": release(PLAIN, ["target"]),
    });

    expect(result.onsets).toHaveLength(1);
    const onset = result.onsets[0];
    expect(onset?.target).toBe("build.target");
    expect(onset?.introducedAt).toBe("1.2.0");
    // The number a stranded consumer actually wants: the last release they
    // could have sat on without this.
    expect(onset?.lastCleanVersion).toBe("1.1.0");
    expect(onset?.releasesAffected).toBe(2);
    expect(onset?.resolvedAt).toBeNull();
  });

  test("a finding present in the first release walked has no clean predecessor", async () => {
    const result = await walk({ "1.0.0": release(PLAIN, ["target"]), "1.1.0": release(PLAIN, ["target"]) });
    // Classifying the first version alone is what makes this right. Without it,
    // a defect present from the start would be blamed on the second release.
    expect(result.onsets[0]?.introducedAt).toBe("1.0.0");
    expect(result.onsets[0]?.lastCleanVersion).toBeNull();
  });

  test("reports the release that fixed it", async () => {
    const result = await walk({
      "1.0.0": release(PLAIN, []),
      "1.1.0": release(PLAIN, ["target"]),
      "1.2.0": release(DOCUMENTED, ["target"]),
    });
    // 1.2.0 documents `target` in prose, so the finding stops.
    expect(result.onsets[0]?.resolvedAt).toBe("1.2.0");
    expect(result.summary.unresolved).toBe(0);
  });

  test("counts findings with no structural signal separately", async () => {
    const result = await walk({
      "1.0.0": release(PLAIN, []),
      "1.1.0": release(PLAIN, ["target"]),
    });
    // Adding an optional parameter breaks no caller, so no structural check
    // fires. That count is the whole argument.
    expect(result.summary.distinctFindings).toBe(1);
    expect(result.summary.silent).toBe(1);
    expect(result.summary.alsoStructural).toBe(0);
  });

  test("one defect across many releases is one row, not many", async () => {
    const result = await walk({
      "1.0.0": release(PLAIN, []),
      "1.1.0": release(PLAIN, ["target"]),
      "1.2.0": release(PLAIN, ["target"]),
      "1.3.0": release(PLAIN, ["target"]),
    });
    expect(result.onsets).toHaveLength(1);
    expect(result.onsets[0]?.releasesAffected).toBe(3);
  });

  test("walks a bounded window", async () => {
    const versions = {
      "1.0.0": release(PLAIN, []),
      "1.1.0": release(PLAIN, []),
      "1.2.0": release(PLAIN, ["target"]),
      "1.3.0": release(PLAIN, ["target"]),
    };
    const result = await walk(versions, { since: "1.1.0", until: "1.2.0" });
    expect(result.versions).toEqual(["1.1.0", "1.2.0"]);
    expect(result.onsets[0]?.introducedAt).toBe("1.2.0");
  });

  test("refuses a window bound that was never published", async () => {
    await expect(walk({ "1.0.0": release(PLAIN, []) }, { since: "9.9.9" })).rejects.toThrow(/no published version/);
  });

  test("records releases it could not read instead of calling them clean", async () => {
    const result = await walk({
      "1.0.0": release(PLAIN, []),
      "1.1.0": { "package.json": MANIFEST, "pack.js": "export const = ;;;" },
    });
    const broken = result.steps.find((s) => s.version === "1.1.0");
    expect(broken?.unreadableSurfaces).toEqual(["./pack"]);
  });

  test("orders onsets by when they appeared", async () => {
    const result = await walk({
      "1.0.0": release(PLAIN, []),
      "1.1.0": release(PLAIN, ["target"]),
      "1.2.0": release(PLAIN, ["target", "mode"]),
    });
    expect(result.onsets.map((o) => o.introducedAt)).toEqual(["1.1.0", "1.2.0"]);
  });
});
