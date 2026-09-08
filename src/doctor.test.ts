import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { doctorPackage, doctorVerdict } from "./doctor.js";
import { RegistryError, type Registry } from "./registry/npm.js";
import { memoryRepoSource } from "./blast/repo.js";

/**
 * Offline throughout. The fake registry writes the files a real unpack would,
 * so this exercises the same extraction path a published tarball does.
 */
function registryOf(latest: Record<string, string>, files: Record<string, Record<string, string>>): Registry {
  return {
    async versions(name) {
      const version = latest[name];
      if (version === undefined) throw new RegistryError(`no such package ${name}`);
      return [{ version, publishedAt: "2026-01-01T00:00:00.000Z", deprecated: null }];
    },
    async manifest(name) {
      const version = latest[name];
      if (version === undefined) throw new RegistryError(`could not read the release history of ${name}`);
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

/** A pack whose tools are named, so a removal is a structural change. */
function pack(name: string, tools: readonly string[], optional: readonly string[] = []): Record<string, string> {
  const properties = ['request: { type: "string" }', ...optional.map((p) => `${p}: { type: "string" }`)];
  const descriptors = tools.map(
    (tool) => `{
      name: ${JSON.stringify(tool)},
      description: "Build a screen from a request.",
      inputSchema: { type: "object", properties: { ${properties.join(", ")} }, required: ["request"] },
    }`,
  );
  return {
    "package.json": JSON.stringify({ name, version: "0.0.0", exports: { ".": "./pack.js" } }),
    "pack.js": `export const tools = [${descriptors.join(", ")}];`,
  };
}

/** A project directory with real files in node_modules, as a checkout would have. */
function project(
  deps: Record<string, { version: string; files: Record<string, string>; range?: string }>,
  options: { manifest?: boolean; installed?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "stantal-doctor-"));
  if (options.manifest !== false) {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "consumer",
        dependencies: Object.fromEntries(
          Object.entries(deps).map(([name, dep]) => [name, dep.range ?? `^${dep.version}`]),
        ),
      }),
      "utf8",
    );
  }
  if (options.installed === false) return root;
  for (const [name, dep] of Object.entries(deps)) {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    for (const [path, body] of Object.entries(dep.files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(
        full,
        path === "package.json" ? JSON.stringify({ ...JSON.parse(body), version: dep.version }) : body,
        "utf8",
      );
    }
  }
  return root;
}

async function doctor(root: string, pkg: string, registry: Registry, extra: Record<string, unknown> = {}) {
  return doctorPackage({
    package: pkg,
    directory: root,
    registry,
    judge: null,
    cacheRoot: mkdtempSync(join(tmpdir(), "stantal-doctor-cache-")),
    ...extra,
  });
}

describe("doctorPackage", () => {
  test("works out the pair from what is installed and what is newest", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", ["build"]) } });
    const registry = registryOf(
      { "@example/tools": "2.0.0" },
      {
        "@example/tools@1.0.0": pack("@example/tools", ["build"]),
        "@example/tools@2.0.0": pack("@example/tools", ["build"], ["target"]),
      },
    );

    const result = await doctor(root, "@example/tools", registry);
    expect(result.status).toBe("checked");
    expect(result.installed).toBe("1.0.0");
    expect(result.target).toBe("2.0.0");
    expect(result.range).toBe("^1.0.0");
    expect(doctorVerdict(result)).toBe("prose-risk");
  });

  test("--against judges a named release instead of the newest", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", ["build"]) } });
    const registry = registryOf(
      { "@example/tools": "3.0.0" },
      {
        "@example/tools@1.0.0": pack("@example/tools", ["build"]),
        "@example/tools@2.0.0": pack("@example/tools", ["build"]),
      },
    );

    const result = await doctor(root, "@example/tools", registry, { target: "2.0.0" });
    expect(result.target).toBe("2.0.0");
    expect(doctorVerdict(result)).toBe("clean");
  });

  /**
   * The three states a provider's CLI will hit most often, in repositories that
   * have nothing to do with them. None of them may present as a pass, and none
   * may present as a failure either.
   */
  test("a package this project does not depend on is not-a-dependency", async () => {
    const root = project({});
    const result = await doctor(root, "@example/tools", registryOf({}, {}));
    expect(result.status).toBe("not-a-dependency");
    expect(doctorVerdict(result)).toBe("not-applicable");
  });

  test("declared but not installed is its own answer", async () => {
    const root = project(
      { "@example/tools": { version: "1.0.0", files: pack("@example/tools", ["build"]) } },
      { installed: false },
    );
    const result = await doctor(root, "@example/tools", registryOf({}, {}));
    expect(result.status).toBe("not-installed");
    expect(result.range).toBe("^1.0.0");
    expect(doctorVerdict(result)).toBe("not-applicable");
  });

  test("installed with no readable contract is not clean", async () => {
    const root = project({
      "left-pad": {
        version: "1.0.0",
        files: {
          "package.json": JSON.stringify({ name: "left-pad", main: "./index.js" }),
          "index.js": "export const pad = 1;",
        },
      },
    });
    const result = await doctor(root, "left-pad", registryOf({ "left-pad": "2.0.0" }, {}));
    expect(result.status).toBe("no-contract");
    // The distinction the whole type exists for: we read nothing, so we claim
    // nothing. `clean` here would be a provider counting an unmeasured repo.
    expect(doctorVerdict(result)).toBe("not-applicable");
  });

  test("a project with no readable manifest is a gap, never an absence", async () => {
    const root = project({}, { manifest: false });
    const result = await doctor(root, "@example/tools", registryOf({}, {}));
    expect(result.status).toBe("unreachable");
    expect(doctorVerdict(result)).toBe("unreadable");
  });

  test("a registry it could not reach is a gap, never a pass", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", ["build"]) } });
    const result = await doctor(root, "@example/tools", registryOf({}, {}));
    expect(result.status).toBe("unreachable");
    expect(doctorVerdict(result)).toBe("unreadable");
  });

  test("already on the newest release is clean, and says so", async () => {
    const root = project({ "@example/tools": { version: "2.0.0", files: pack("@example/tools", ["build"]) } });
    const result = await doctor(root, "@example/tools", registryOf({ "@example/tools": "2.0.0" }, {}));
    expect(result.status).toBe("current");
    expect(doctorVerdict(result)).toBe("clean");
  });

  /**
   * The reason this command exists in the provider direction: it runs where the
   * consumer's code is, so the answer is about their lines rather than about
   * the package in the abstract.
   */
  test("joins a removed tool to the consumer's own call site", async () => {
    const root = project({ "@example/tools": { version: "1.0.0", files: pack("@example/tools", ["build"]) } });
    // A caret range, and a minor release inside it. The finding has to be one
    // the consumer's own manifest already admits, or Layer 3 filters it before
    // the scan and there is nothing left to join.
    const registry = registryOf(
      { "@example/tools": "1.1.0" },
      {
        "@example/tools@1.0.0": pack("@example/tools", ["build"]),
        // The tool was renamed, which is a removal plus an addition.
        "@example/tools@1.1.0": pack("@example/tools", ["assemble"]),
      },
    );

    const result = await doctor(root, "@example/tools", registry, {
      repo: memoryRepoSource({
        "package.json": JSON.stringify({ dependencies: { "@example/tools": "^1.0.0" } }),
        "src/agent.ts": 'import { tools } from "@example/tools";\nif (call.name === "build") run();\n',
      }),
    });

    expect(result.report?.breaks.map((b) => `${b.rule} ${b.target}`)).toContain("tool_removed build");
    expect(result.report?.breaks[0]?.evidence).toContain("src/agent.ts");
  });
});
