import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planReapply, wireReapply } from "./reapply.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stantal-wire-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manifest(body: Record<string, unknown>): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(body, null, 2), "utf8");
}

describe("making a patch reapply", () => {
  it("sets the hook when there is none", () => {
    manifest({ name: "app", scripts: { build: "tsc" } });
    expect(wireReapply(root).kind).toBe("wired");

    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(after.scripts["postinstall"]).toBe("patch-package");
    // Everything else is left exactly as it was.
    expect(after.scripts["build"]).toBe("tsc");
  });

  it("does nothing when it already runs", () => {
    manifest({ name: "app", scripts: { postinstall: "patch-package" } });
    expect(wireReapply(root).kind).toBe("already");
  });

  it("refuses to rewrite a postinstall that does something else", () => {
    // A postinstall runs on every install on every machine. Appending to
    // somebody's build step on their behalf is a much larger change than
    // writing a patch file, and getting it wrong breaks every install.
    manifest({ name: "app", scripts: { postinstall: "node scripts/setup.js" } });
    const outcome = wireReapply(root);
    expect(outcome.kind).toBe("refused");
    expect(outcome.detail).toContain("node scripts/setup.js");

    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(after.scripts["postinstall"]).toBe("node scripts/setup.js");
  });

  it("never adds the dependency, because that would mean inventing a version", () => {
    manifest({ name: "app" });
    wireReapply(root);
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    expect(after["devDependencies"]).toBeUndefined();
  });

  it("plans without writing", () => {
    expect(planReapply({ scripts: { postinstall: "patch-package && husky" } }).kind).toBe("already");
    expect(planReapply({}).kind).toBe("wired");
  });
});
