import { describe, expect, it } from "vitest";
import { memoryRepoSource } from "./repo.js";
import { blastRadius, subpathOf, type BlastTarget } from "./scan.js";
import { canClaimUnaffected } from "./taxonomy.js";

const PKG = "@acme/tools";

const APP: BlastTarget = {
  label: "make.target",
  surface: "./ai-sdk",
  tool: "make_thing",
  param: "target",
};

const OTHER_DOOR: BlastTarget = {
  label: "other.thing",
  surface: "./server",
  tool: "other_tool",
};

function repo(files: Record<string, string>) {
  return memoryRepoSource(files);
}

function manifest(range: string | null, field = "dependencies") {
  return JSON.stringify(range === null ? { name: "consumer" } : { name: "consumer", [field]: { [PKG]: range } });
}

const USES = `
import { makePack } from "@acme/tools/ai-sdk";
export const tools = makePack();
export async function run() {
  return tools.make_thing({ request: "hello", target: "Roles" });
}
`;

function scan(files: Record<string, string>, targets: BlastTarget[] = [APP]) {
  return blastRadius({
    repo: repo(files),
    package: PKG,
    affectedVersions: ["0.9.0", "0.24.0", "0.51.1"],
    targets,
  });
}

describe("subpathOf", () => {
  it("maps a specifier onto the door it opens", () => {
    expect(subpathOf("@acme/tools", PKG)).toBe(".");
    expect(subpathOf("@acme/tools/ai-sdk", PKG)).toBe("./ai-sdk");
    expect(subpathOf("@acme/tools/a/b", PKG)).toBe("./a/b");
  });

  it("does not match a different package that shares a prefix", () => {
    // A plain startsWith would call this a match, and every finding about one
    // package would be reported against a neighbour that merely reads alike.
    expect(subpathOf("@acme/tools-extra", PKG)).toBeNull();
    expect(subpathOf("@acme/toolsx", PKG)).toBeNull();
  });
});

describe("dependency reach", () => {
  it("reports a range that admits an affected version", () => {
    const result = scan({ "package.json": manifest("^0.24.0"), "src/a.ts": USES });
    const dep = result.reaches.find((r) => r.kind === "dependency");
    expect(dep?.evidence).toBe("package.json (dependencies)");
  });

  it("filters a range that admits none of them", () => {
    // Pinned below the onset. The finding is true and cannot reach this repo.
    const result = scan({ "package.json": manifest("0.7.0"), "src/a.ts": USES });
    expect(result.reaches).toEqual([]);
    expect(result.filtered[0]?.reason).toContain("admits no affected version");
    expect(canClaimUnaffected(result)).toBe(true);
  });

  it("judges the declared range, not the version installed today", () => {
    // ^0.9.0 resolves to whatever is newest at install time. A consumer needs
    // to know before the next install, not after it.
    const result = scan({ "package.json": manifest("^0.9.0"), "src/a.ts": USES });
    expect(result.reaches.some((r) => r.kind === "dependency")).toBe(true);
  });

  it("looks in every dependency field, not just `dependencies`", () => {
    for (const field of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
      const result = scan({ "package.json": manifest("^0.24.0", field), "src/a.ts": USES });
      expect(result.reaches.some((r) => r.kind === "dependency")).toBe(true);
    }
  });

  it("stops early when the manifest does not name the package at all", () => {
    const result = scan({ "package.json": manifest(null), "src/a.ts": USES });
    expect(result.filtered[0]?.reason).toContain("not a declared dependency");
    expect(canClaimUnaffected(result)).toBe(true);
  });
});

describe("absent is not unaffected", () => {
  it("records a missing manifest as a gap, never as `not a dependency`", () => {
    // A workspace member or a repo we were pointed at one level too deep both
    // land here, and both may still use the package.
    const result = scan({ "src/a.ts": USES });
    expect(result.notes.some((n) => n.where === "package.json")).toBe(true);
    expect(canClaimUnaffected(result)).toBe(false);
  });

  it("records an uncomparable range rather than resolving it either way", () => {
    const result = scan({ "package.json": manifest("workspace:*"), "src/a.ts": USES });
    expect(result.notes.some((n) => n.detail.includes("not a comparable semver range"))).toBe(true);
    // Not filtered, and not claimed as a version reach. Unknown stays unknown.
    expect(result.reaches.some((r) => r.kind === "dependency")).toBe(false);
    expect(result.filtered).toEqual([]);
  });

  it("a repo with nothing in it cannot support `unaffected` on its own", () => {
    const result = scan({});
    expect(canClaimUnaffected(result)).toBe(false);
  });
});

describe("surface reach", () => {
  const files = { "package.json": manifest("^0.24.0"), "src/a.ts": USES };

  it("points at the line that opens the door", () => {
    const result = scan(files);
    const surface = result.reaches.find((r) => r.kind === "surface_import");
    expect(surface?.target).toBe("./ai-sdk");
    expect(surface?.evidence).toBe("src/a.ts:2");
  });

  it("filters a finding on a door the repo never opens", () => {
    // The sharpest filter in the layer: one package exposes several doors
    // carrying different contracts, and a finding on one you do not import
    // cannot reach you however true it is.
    const result = blastRadius({
      repo: repo(files),
      package: PKG,
      affectedVersions: ["0.24.0"],
      targets: [OTHER_DOOR],
    });
    expect(result.reaches.some((r) => r.kind === "surface_import")).toBe(false);
    expect(result.filtered[0]?.reason).toContain("does not import");
  });

  it("does not filter a surface that is not a subpath", () => {
    // A `bin:` surface is a command and a manifest is a file. Neither is
    // something a repo imports, so import specifiers cannot rule them out.
    const result = blastRadius({
      repo: repo(files),
      package: PKG,
      affectedVersions: ["0.24.0"],
      targets: [{ label: "cli.run", surface: "bin:acme", tool: "make_thing" }],
    });
    expect(result.filtered).toEqual([]);
  });
});

describe("tool and parameter reach", () => {
  const files = { "package.json": manifest("^0.24.0"), "src/a.ts": USES };

  it("points at the tool by name", () => {
    const result = scan(files);
    const tool = result.reaches.find((r) => r.kind === "tool_reference");
    expect(tool?.target).toBe("make_thing");
    expect(tool?.evidence).toBe("src/a.ts:5");
  });

  it("only counts a parameter inside a file that uses its tool", () => {
    // `target`, `app`, `context` are ordinary words. Matched repo-wide they
    // return every file and mean nothing.
    const noisy = {
      ...files,
      "src/unrelated.ts": "export const target = process.env.TARGET; // nothing to do with the pack\n",
    };
    const result = scan(noisy);
    const params = result.reaches.filter((r) => r.kind === "param_reference");
    expect(params).toHaveLength(1);
    expect(params[0]?.evidence).toBe("src/a.ts:5");
  });

  it("says nothing about a parameter when the tool is never named", () => {
    const result = scan({
      "package.json": manifest("^0.24.0"),
      "src/a.ts": 'import x from "@acme/tools/ai-sdk";\nexport const target = 1;\n',
    });
    expect(result.reaches.some((r) => r.kind === "param_reference")).toBe(false);
  });
});

describe("what gets scanned", () => {
  it("skips files that are not source", () => {
    const result = scan({
      "package.json": manifest("^0.24.0"),
      "src/a.ts": USES,
      "README.md": "make_thing target target target",
      "yarn.lock": "make_thing",
    });
    expect(result.scanned.files).toBe(2); // package.json + src/a.ts
    expect(result.reaches.every((r) => !r.evidence.startsWith("README"))).toBe(true);
  });

  it("skips our own emitted suite, which names every tool it pins", () => {
    // Found by running it: a two-file project reported 37 call sites, 34 of
    // them inside the file `stantal pin` had just written. Counting our own
    // output as the consumer's code buries the reaches that are real.
    const result = scan({
      "package.json": manifest("^0.24.0"),
      "src/a.ts": USES,
      "stantal/acme-tools.ai-sdk.contract.test.ts":
        "// Generated by stantal 0.4.0 on 2026-08-29T00:00:00.000Z.\n" +
        'it("still offers make_thing", () => { findTool(c, "make_thing"); });\n' +
        'it("still takes target", () => { findParam(c, "make_thing", "target"); });\n',
    });

    expect(result.reaches.every((r) => !r.evidence.startsWith("stantal/"))).toBe(true);
    // Skipped as ours, not counted as unreadable — a note here would stop this
    // result from ever supporting "nothing reaches you".
    expect(result.notes).toEqual([]);
    expect(result.scanned.files).toBe(2);
  });
});

describe("generated files are not call sites", () => {
  it("never points at a lockfile", () => {
    // A lockfile names every transitive package and pins its version, so a scan
    // that reads one reports a call site at package-lock.json:2279. That is
    // worse than a missed reach: a checkable claim that does not survive being
    // checked, in the layer a consumer uses to decide whether to act.
    const result = scan({
      "package.json": manifest("^0.24.0"),
      "package-lock.json": JSON.stringify({ packages: { "": { dependencies: { make_thing: "1.0.0" } } } }),
      "src/a.ts": USES,
    });
    expect(result.reaches.every((r) => !r.evidence.includes("package-lock.json"))).toBe(true);
    expect(result.scanned.files).toBe(2);
  });
});
