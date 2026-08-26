import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { scriptedCaller, type CallRequest, type ToolChoice } from "./behaviour/caller.js";
import type { Intent } from "./behaviour/intent.js";
import { RegistryError, type Registry } from "./registry/npm.js";
import { buildReport, exitCodeFor, type BehaviourOptions } from "./report.js";

/** Offline: the fake registry writes the files a real unpack would. */
function registryOf(packages: Record<string, Record<string, string>>): Registry {
  return {
    async versions() {
      return [];
    },
    async manifest(name, spec) {
      const exact = spec.replace(/^[\^~]/, "");
      if (packages[`${name}@${exact}`] === undefined) throw new RegistryError(`no ${name}@${spec}`);
      return { version: exact, dependencies: {} };
    },
    async extract(name, version, destination) {
      const files = packages[`${name}@${version}`];
      if (files === undefined) throw new RegistryError(`no ${name}@${version}`);
      for (const [path, contents] of Object.entries(files)) {
        const full = join(destination, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, contents, "utf8");
      }
    },
  };
}

function cacheRoot(): string {
  return mkdtempSync(join(tmpdir(), "stantal-report-"));
}

const manifest = (exports: Record<string, string>) =>
  JSON.stringify({ name: "@example/tools", version: "0.0.0", exports });

function pack(tools: string): string {
  return `export const tools = ${tools};`;
}

const DESCRIBED = pack(`[{
  name: "build",
  description: "Build a screen. Pass \\\`slot\\\` only when the request names a place for it to land.",
  inputSchema: { type: "object", properties: { request: { type: "string" }, slot: { type: "string" } }, required: ["request"] },
}]`);

const BARE = pack(`[{
  name: "build",
  description: "Build a screen. Pass \\\`slot\\\` only when the request names a place for it to land.",
  inputSchema: { type: "object", properties: { request: { type: "string" }, slot: { type: "string" }, target: { type: "string" } }, required: ["request"] },
}]`);

/** Same tool, reworded: the sentence explaining `slot` is gone. */
const REWORDED = pack(`[{
  name: "build",
  description: "Build a screen.",
  inputSchema: { type: "object", properties: { request: { type: "string" }, slot: { type: "string" }, target: { type: "string" } }, required: ["request"] },
}]`);

const packFiles = (contents: string) => ({ "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": contents });

type Extra = { subpaths?: string[]; behaviour?: BehaviourOptions };

async function report(from: Record<string, string>, to: Record<string, string>, extra: Extra = {}) {
  return buildReport({
    package: "@example/tools",
    from: "1.0.0",
    to: "2.0.0",
    registry: registryOf({ "@example/tools@1.0.0": from, "@example/tools@2.0.0": to }),
    cacheRoot: cacheRoot(),
    ...(extra.subpaths ? { subpaths: extra.subpaths } : {}),
    ...(extra.behaviour ? { behaviour: extra.behaviour } : {}),
  });
}

const INTENTS: Intent[] = [
  { id: "i1", text: "make me a roles screen", slice: ["build"], expectsNoCall: false },
];

/**
 * A model that fills a field as soon as one is declared for it.
 *
 * Scripted rather than real, per `docs/how-to-move-fast.md`: a model in the
 * loop is slow, priced, and disagrees with itself, which makes a failing test
 * unreadable. It reads the schema it was handed so that "behaves differently on
 * version B" is expressible at all — a script that ignores its tools cannot say
 * anything about a contract.
 */
function fieldFillingCaller() {
  return scriptedCaller("test:model", (request: CallRequest): ToolChoice => {
    const tool = request.tools[0];

    // Seeding asks through the same caller, so the corpus request has to be
    // answered here too or the seeded path cannot be tested offline.
    if (tool?.name === "propose_intents") {
      return {
        kind: "tool_call",
        tool: "propose_intents",
        arguments: { intents: [{ text: "make me a roles screen", tools: ["build"], expectsNoCall: false }] },
      };
    }

    // A field the model was not shown is one it cannot fill. Filling it anyway
    // would be an invalid call, which is a different rule.
    const declared = tool !== undefined && "target" in tool.inputSchema.properties;
    return {
      kind: "tool_call",
      tool: "build",
      arguments: declared ? { request: "a roles screen", target: "Roles" } : { request: "a roles screen" },
    };
  });
}

describe("buildReport", () => {
  test("an unchanged contract is clean", async () => {
    const files = { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED };
    const result = await report(files, files);
    expect(result.verdict).toBe("clean");
    expect(exitCodeFor(result.verdict)).toBe(0);
  });

  test("a new undocumented optional parameter is prose-risk", async () => {
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED },
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": BARE },
    );
    expect(result.verdict).toBe("prose-risk");
    expect(result.surfaces[0]?.prose.findings.map((f) => f.target)).toEqual(["build.target"]);
    expect(exitCodeFor(result.verdict)).toBe(1);
  });

  test("reads every door the package declares, without being told", async () => {
    const files = {
      "package.json": manifest({ ".": "./index.js", "./pack": "./pack.js", "./other": "./other.js" }),
      "index.js": "export const version = 1;",
      "pack.js": DESCRIBED,
      "other.js": DESCRIBED,
    };
    const result = await report(files, files);
    // A package with three entry points has three contracts, and each is read
    // on its own. Two doors of one version routinely disagree.
    expect(result.surfaces.map((s) => s.subpath).sort()).toEqual([".", "./other", "./pack"]);
  });

  test("never reports clean when it could not read the package", async () => {
    const broken = { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": "export const = ;;;" };
    const result = await report(broken, broken, { subpaths: ["./pack"] });
    // Silence from a failed read is not evidence of no change.
    expect(result.verdict).toBe("unreadable");
    expect(exitCodeFor(result.verdict)).toBe(2);
  });

  test("a surface that did not exist before is not a pile of changes", async () => {
    const result = await report(
      { "package.json": manifest({ ".": "./index.js" }), "index.js": "export const v = 1;" },
      { "package.json": manifest({ ".": "./index.js", "./pack": "./pack.js" }), "index.js": "export const v = 2;", "pack.js": DESCRIBED },
    );
    const introduced = result.surfaces.find((s) => s.subpath === "./pack");
    expect(introduced?.comparison.kind).toBe("surface_introduced");
    expect(introduced?.comparison.diff).toBeNull();
  });

  test("a withdrawn entry point is breaking", async () => {
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED },
      { "package.json": manifest({ ".": "./index.js" }), "index.js": "export const v = 2;" },
    );
    expect(result.verdict).toBe("structurally-breaking");
    expect(result.headline).toContain("./pack");
  });

  test("records that no judge ran, so an unconfirmed finding reads as one", async () => {
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": DESCRIBED },
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": BARE },
    );
    expect(result.judge).toBe("none");
    expect(result.surfaces[0]?.prose.findings[0]?.confidence).toBe("unconfirmed");
  });

});

describe("Layer 2 in the verdict", () => {
  test("a model seen doing something else is behaviour-breaking", async () => {
    const caller = fieldFillingCaller();
    const result = await report(packFiles(DESCRIBED), packFiles(BARE), {
      behaviour: { caller, intents: INTENTS },
    });

    expect(result.verdict).toBe("behaviour-breaking");
    expect(exitCodeFor(result.verdict)).toBe(1);
    expect(result.caller).toBe("test:model");
    expect(result.surfaces[0]?.behaviour?.findings.map((f) => f.rule)).toEqual(["new_field_used"]);
    expect(result.surfaces[0]?.behaviour?.findings[0]?.target).toBe("build.target");
    // The same pair also raises a prose finding. Behaviour outranks it, because
    // "a model did this" is a stronger claim than "a model might read this".
    expect(result.surfaces[0]?.prose.findings.map((f) => f.target)).toEqual(["build.target"]);
    expect(result.headline).toContain("`target`");
  });

  test("no caller is a normal run, not an error", async () => {
    const result = await report(packFiles(DESCRIBED), packFiles(BARE), { behaviour: { caller: null } });

    // The stated guarantee: a first run with no account and no key still gets a
    // full document and a clean exit, minus only the section a model fills in.
    expect(result.verdict).toBe("prose-risk");
    expect(exitCodeFor(result.verdict)).toBe(1);
    expect(result.caller).toBe("none");
    expect(result.surfaces[0]?.behaviour).toBeNull();
    expect(result.surfaces[0]?.prose.findings).toHaveLength(1);
  });

  test("stays off unless it is asked for, even with a caller in hand", async () => {
    const caller = fieldFillingCaller();
    const result = await report(packFiles(DESCRIBED), packFiles(BARE));

    // k calls per intent per side is real money, so having a model available is
    // never on its own a reason to spend it.
    expect(caller.calls).toHaveLength(0);
    expect(result.surfaces[0]?.behaviour).toBeNull();
    expect(result.caller).toBe("none");
    expect(result.verdict).toBe("prose-risk");
  });

  test("does not put a model in front of a contract that did not change", async () => {
    const caller = fieldFillingCaller();
    const result = await report(packFiles(DESCRIBED), packFiles(DESCRIBED), {
      behaviour: { caller, intents: INTENTS },
    });

    // Two rates measured off the same contract can differ by chance alone, so
    // running this would only ever manufacture a finding.
    expect(caller.calls).toHaveLength(0);
    expect(result.surfaces[0]?.behaviour).toBeNull();
    expect(result.verdict).toBe("clean");
  });

  test("seeds its corpus from the older side when none is supplied", async () => {
    const caller = fieldFillingCaller();
    const result = await report(packFiles(DESCRIBED), packFiles(REWORDED), {
      behaviour: { caller, seedCacheDir: cacheRoot() },
    });

    const seeded = caller.calls[0];
    expect(seeded?.tools[0]?.name).toBe("propose_intents");
    // The request describes the *older* contract. Seeding from the newer one
    // would write the intent against the prose under test, and the measurement
    // would be circular.
    expect(seeded?.intent).toContain("Pass `slot` only when");
    expect(result.surfaces[0]?.behaviour?.corpus).toBe(1);
    expect(result.verdict).toBe("behaviour-breaking");
  });

  test("skips a door where one side could not be read", async () => {
    const caller = fieldFillingCaller();
    const result = await report(
      { "package.json": manifest({ "./pack": "./pack.js" }), "pack.js": "export const = ;;;" },
      packFiles(BARE),
      { behaviour: { caller, intents: INTENTS }, subpaths: ["./pack"] },
    );

    // An unreadable side is not a model behaving differently, it is nothing to
    // show the model. Claiming otherwise would report our blind spot as theirs.
    expect(caller.calls).toHaveLength(0);
    expect(result.surfaces[0]?.behaviour).toBeNull();
    expect(result.verdict).not.toBe("behaviour-breaking");
  });
});

describe("exitCodeFor", () => {
  test("three values a CI step can branch on without parsing", () => {
    expect(exitCodeFor("clean")).toBe(0);
    expect(exitCodeFor("prose-risk")).toBe(1);
    expect(exitCodeFor("structurally-breaking")).toBe(1);
    expect(exitCodeFor("behaviour-breaking")).toBe(1);
    expect(exitCodeFor("unreadable")).toBe(2);
  });
});
