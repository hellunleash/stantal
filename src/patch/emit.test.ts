import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { patchFileName, renderPatchFile } from "./emit.js";
import type { PatchEdit, PatchPlan } from "./taxonomy.js";

function edit(file: string, find: string, replace: string): PatchEdit {
  return { file, tool: "build", subpath: ".", find, replace, encoding: "raw", why: "restored" };
}

function planOf(edits: PatchEdit[]): PatchPlan {
  return { package: "@example/tools", version: "2.0.0", edits, refused: [] };
}

/**
 * A package on disk, plus a git repository laid out the way `patch-package`
 * expects — the patch addresses `node_modules/<pkg>/<file>` from the project
 * root, so that is where the file has to be for `git apply` to find it.
 */
function project(files: Record<string, string>): { root: string; packageDir: string } {
  const root = mkdtempSync(join(tmpdir(), "stantal-emit-"));
  const packageDir = join(root, "node_modules", "@example", "tools");
  mkdirSync(packageDir, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    const full = join(packageDir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, packageDir };
}

/** The only test that matters: does git accept it? */
function gitApplyCheck(root: string, patch: string): { ok: boolean; detail: string } {
  const file = join(root, "candidate.patch");
  writeFileSync(file, patch, "utf8");
  try {
    execFileSync("git", ["apply", "--check", "--verbose", "candidate.patch"], {
      cwd: root,
      stdio: "pipe",
    });
    return { ok: true, detail: "" };
  } catch (error) {
    const e = error as { stderr?: Buffer };
    return { ok: false, detail: e.stderr?.toString() ?? String(error) };
  }
}

function gitApply(root: string, patch: string): void {
  writeFileSync(join(root, "candidate.patch"), patch, "utf8");
  execFileSync("git", ["apply", "candidate.patch"], { cwd: root, stdio: "pipe" });
}

const PACK = `export const tools = [
  {
    name: "build",
    description: "Build a screen from a request.",
    inputSchema: { type: "object" },
  },
];
`;

describe("renderPatchFile", () => {
  test("produces a patch git accepts, and that restores the text", () => {
    const { root, packageDir } = project({ "dist/pack.js": PACK });
    const plan = planOf([
      edit(
        "dist/pack.js",
        `description: "Build a screen from a request.",`,
        `description: "Build a screen from a request. Pass \`target\` only when changing an existing one.",`,
      ),
    ]);

    const rendered = renderPatchFile(plan, packageDir);
    expect(rendered).not.toBeNull();

    // Not "it looks like a diff" — git is the parser that has to accept it.
    const check = gitApplyCheck(root, rendered!.text);
    expect(check.ok, check.detail).toBe(true);

    gitApply(root, rendered!.text);
    const after = readFileSync(join(packageDir, "dist/pack.js"), "utf8");
    expect(after).toContain("Pass `target` only when changing an existing one.");
    // Everything around it is untouched, which is the whole promise of an
    // exactly-once replacement.
    expect(after).toContain(`name: "build"`);
    expect(after).toContain(`inputSchema: { type: "object" }`);
  });

  test("addresses the file through node_modules, as patch-package resolves it", () => {
    const { root, packageDir } = project({ "dist/pack.js": PACK });
    const rendered = renderPatchFile(
      planOf([edit("dist/pack.js", `"Build a screen from a request."`, `"Build a screen."`)]),
      packageDir,
    );
    expect(rendered?.text).toContain("a/node_modules/@example/tools/dist/pack.js");
    expect(rendered?.name).toBe("@example+tools+2.0.0.patch");
    void root;
  });

  test("two edits far apart in one file both apply", () => {
    const long = [
      `const a = 1;`,
      ...Array.from({ length: 40 }, (_, i) => `const filler${i} = ${i};`),
      `const first = "ONE";`,
      ...Array.from({ length: 40 }, (_, i) => `const more${i} = ${i};`),
      `const second = "TWO";`,
      `const z = 2;`,
    ].join("\n");

    const { root, packageDir } = project({ "dist/pack.js": long });
    const rendered = renderPatchFile(
      planOf([
        edit("dist/pack.js", `"ONE"`, `"ONE RESTORED"`),
        edit("dist/pack.js", `"TWO"`, `"TWO RESTORED"`),
      ]),
      packageDir,
    );

    // Two hunks, not one spanning eighty lines of untouched filler.
    expect((rendered?.text.match(/^@@ /gm) ?? []).length).toBe(2);
    const check = gitApplyCheck(root, rendered!.text);
    expect(check.ok, check.detail).toBe(true);

    gitApply(root, rendered!.text);
    const after = readFileSync(join(packageDir, "dist/pack.js"), "utf8");
    expect(after).toContain(`"ONE RESTORED"`);
    expect(after).toContain(`"TWO RESTORED"`);
  });

  test("two edits close together become one hunk that still applies", () => {
    const near = ["const x = 1;", `const a = "ONE";`, `const b = "TWO";`, "const y = 2;"].join("\n");
    const { root, packageDir } = project({ "dist/pack.js": near });
    const rendered = renderPatchFile(
      planOf([
        edit("dist/pack.js", `"ONE"`, `"ONE!"`),
        edit("dist/pack.js", `"TWO"`, `"TWO!"`),
      ]),
      packageDir,
    );

    // Separate hunks here would have overlapping context, which git rejects.
    expect((rendered?.text.match(/^@@ /gm) ?? []).length).toBe(1);
    const check = gitApplyCheck(root, rendered!.text);
    expect(check.ok, check.detail).toBe(true);
  });

  test("a minified single-line file still applies", () => {
    const minified = `export const tools=[{name:"build",description:"Build a screen.",inputSchema:{}}];`;
    const { root, packageDir } = project({ "dist/pack.js": minified });
    const rendered = renderPatchFile(
      planOf([edit("dist/pack.js", `"Build a screen."`, `"Build a screen. Pass target."`)]),
      packageDir,
    );

    const check = gitApplyCheck(root, rendered!.text);
    expect(check.ok, check.detail).toBe(true);
  });

  test("an empty plan renders nothing, rather than an empty patch", () => {
    const { packageDir } = project({ "dist/pack.js": PACK });
    // An empty patch file that patch-package accepts would read as a
    // restoration that is in place, with nothing to notice when it is not.
    expect(renderPatchFile(planOf([]), packageDir)).toBeNull();
  });

  test("a file it cannot read is dropped, never guessed at", () => {
    const { packageDir } = project({ "dist/pack.js": PACK });
    const rendered = renderPatchFile(
      planOf([
        edit("dist/pack.js", `"Build a screen from a request."`, `"Build."`),
        edit("dist/missing.js", `"gone"`, `"back"`),
      ]),
      packageDir,
    );
    expect(rendered?.files).toEqual(["dist/pack.js"]);
  });
});

describe("patchFileName", () => {
  test("matches what patch-package looks for", () => {
    expect(patchFileName("@scope/name", "1.2.3")).toBe("@scope+name+1.2.3.patch");
    expect(patchFileName("plain", "0.1.0")).toBe("plain+0.1.0.patch");
  });
});
