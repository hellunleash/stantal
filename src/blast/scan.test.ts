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
  it("reads prose for quotes, and never as a call site", () => {
    const result = scan({
      "package.json": manifest("^0.24.0"),
      "src/a.ts": USES,
      "README.md": "make_thing target target target",
      "yarn.lock": "make_thing",
    });
    // Markdown is read, because a system prompt is as often a file as a string
    // literal and `stale_quote` has to be able to see it. A lockfile is not.
    expect(result.scanned.files).toBe(3); // package.json + src/a.ts + README.md
    // Naming a tool in documentation is not a line that stops working, so no
    // reach may be anchored there.
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

describe("when the caller is the model", () => {
  // The failure this kind exists for: a repo imports the package and Layer 3
  // says nothing, because the tools the findings sit on appear in no source
  // line. That is the ordinary case for a contract a model consumes, so the
  // sharpest evidence the layer has goes missing exactly when the product's
  // central claim is most true.
  const MOUNTS = 'import { makePack } from "@acme/tools/ai-sdk";\nexport const tools = makePack();\n';

  it("reports the mount as a reach when no file names the tool", () => {
    const result = scan({ "package.json": manifest("^0.24.0"), "src/agent.ts": MOUNTS });
    const model = result.reaches.find((r) => r.kind === "model_consumer");
    expect(model?.target).toBe("make_thing");
    expect(model?.evidence).toBe("src/agent.ts:1");
    expect(canClaimUnaffected(result)).toBe(false);
  });

  it("gives way to a real call site", () => {
    // A line naming the tool is better evidence and is checkable. Reporting
    // both would say the same thing twice, once vaguely.
    const result = scan({ "package.json": manifest("^0.24.0"), "src/a.ts": USES });
    expect(result.reaches.some((r) => r.kind === "tool_reference")).toBe(true);
    expect(result.reaches.some((r) => r.kind === "model_consumer")).toBe(false);
  });

  it("needs a mount, and never stands in for one", () => {
    // Declared, and no import found anywhere. That is "we did not see how you
    // use it", which the dependency reach already says. Claiming a model
    // consumer here would turn a gap into a positive claim about usage.
    const result = scan({ "package.json": manifest("^0.24.0"), "src/a.ts": "export const x = 1;\n" });
    expect(result.reaches.some((r) => r.kind === "model_consumer")).toBe(false);
    expect(result.reaches.map((r) => r.kind)).toEqual(["dependency"]);
  });

  it("is still filtered out by a door the repo never opens", () => {
    const result = blastRadius({
      repo: repo({ "package.json": manifest("^0.24.0"), "src/agent.ts": MOUNTS }),
      package: PKG,
      affectedVersions: ["0.24.0"],
      targets: [OTHER_DOOR],
    });
    expect(result.reaches.some((r) => r.kind === "model_consumer")).toBe(false);
    expect(result.filtered[0]?.kind).toBe("subpath_not_imported");
  });

  it("ranks below the lines that name a tool", () => {
    const result = scan(
      { "package.json": manifest("^0.24.0"), "src/a.ts": USES },
      [APP, { label: "second.thing", surface: "./ai-sdk", tool: "other_tool" }],
    );
    const kinds = result.reaches.map((r) => r.kind);
    expect(kinds.indexOf("model_consumer")).toBe(kinds.length - 1);
  });
});

describe("one line, said once", () => {
  it("does not repeat a reach that two findings share", () => {
    // Two findings on the same tool reach a consumer at the same line. Printing
    // it twice adds nothing and pushes the reaches that differ off the list.
    const result = scan({ "package.json": manifest("^0.24.0"), "src/a.ts": USES }, [
      APP,
      { label: "make.other", surface: "./ai-sdk", tool: "make_thing", param: "other" },
    ]);
    const surfaces = result.reaches.filter((r) => r.kind === "surface_import");
    expect(surfaces).toHaveLength(1);
    const tools = result.reaches.filter((r) => r.kind === "tool_reference");
    expect(tools).toHaveLength(1);
  });
});

describe("observed calls", () => {
  const MOUNTS = 'import { makePack } from "@acme/tools/ai-sdk";\nexport const tools = makePack();\n';

  function withCalls(files: Record<string, string>, calls: number) {
    return blastRadius({
      repo: repo(files),
      package: PKG,
      affectedVersions: ["0.24.0"],
      targets: [APP],
      usage: {
        source: "traces.json",
        spans: calls,
        notes: [],
        byTool: calls === 0 ? {} : { make_thing: { tool: "make_thing", calls, params: {} } },
      },
    });
  }

  it("reports a tool the traces show being called, and ranks it first", () => {
    const result = withCalls({ "package.json": manifest("^0.24.0"), "src/agent.ts": MOUNTS }, 12);
    expect(result.reaches[0]?.kind).toBe("observed_call");
    expect(result.reaches[0]?.detail).toContain("12 time(s)");
  });

  it("stands in for the mount, which is the weaker version of the same claim", () => {
    const result = withCalls({ "package.json": manifest("^0.24.0"), "src/agent.ts": MOUNTS }, 3);
    expect(result.reaches.some((r) => r.kind === "model_consumer")).toBe(false);
  });

  it("adds evidence and never removes a finding", () => {
    // A tool absent from a trace window is a tool nobody called in that window.
    // Treating it as unused would let a short export clear a real finding.
    const files = { "package.json": manifest("^0.24.0"), "src/a.ts": USES };
    const withoutTraces = scan(files);
    const withEmptyTraces = withCalls(files, 0);
    expect(withEmptyTraces.filtered).toEqual(withoutTraces.filtered);
    expect(withEmptyTraces.reaches.map((r) => r.kind)).toEqual(withoutTraces.reaches.map((r) => r.kind));
  });
});

describe("the trace file is not a call site", () => {
  it("never reports the export the user handed us", () => {
    // It names every tool the agent called, by construction. Scanning it turns
    // one supplied file into a reference per span and buries the real ones —
    // the lockfile mistake again, found the same way, by running it.
    const result = blastRadius({
      repo: repo({
        "package.json": manifest("^0.24.0"),
        "src/agent.ts": 'import { makePack } from "@acme/tools/ai-sdk";\n',
        "traces.json": JSON.stringify({ spans: [{ name: "t", attributes: { "tool.name": "make_thing" } }] }),
      }),
      package: PKG,
      affectedVersions: ["0.24.0"],
      targets: [APP],
      usage: {
        source: "traces.json",
        spans: 1,
        notes: [],
        byTool: { make_thing: { tool: "make_thing", calls: 1, params: {} } },
      },
    });

    expect(result.reaches.some((r) => r.kind === "tool_reference")).toBe(false);
    expect(result.reaches.some((r) => r.kind === "observed_call")).toBe(true);
  });
});

/**
 * The deepest reach in this layer, and the one nothing else in a toolchain can
 * see: the consumer copied a sentence of the tool description into their own
 * prompt, and the provider later deleted it.
 */
describe("stale_quote", () => {
  const SENTENCE = "Pass `slot` only when the request names a particular place to put it.";

  const QUOTED: BlastTarget = {
    label: "make_thing",
    surface: "./ai-sdk",
    tool: "make_thing",
    quotes: [SENTENCE],
  };

  it("finds the deleted sentence in the consumer's own prompt", () => {
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "src/prompt.ts": `export const SYSTEM = \`You are an agent.\n${SENTENCE}\nBe brief.\`;\n`,
      },
      [QUOTED],
    );

    const stale = result.reaches.filter((r) => r.kind === "stale_quote");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.evidence).toBe("src/prompt.ts:2");
    expect(stale[0]?.detail).toContain("quotes a sentence the newer version deleted");
  });

  it("finds it in a markdown prompt, which imports nothing and names no tool", () => {
    // The case the prose extensions exist for. This file has no import, no tool
    // name, and is exactly where a system prompt lives on a real project.
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "prompts/agent.md": `# Agent\n\n${SENTENCE}\n`,
      },
      [QUOTED],
    );

    expect(result.reaches.some((r) => r.kind === "stale_quote" && r.evidence === "prompts/agent.md:3")).toBe(true);
  });

  it("matches across a line wrap, because a prompt is wrapped text", () => {
    const wrapped = "Pass `slot` only when the request\n  names a particular place to put it.";
    const result = scan(
      { "package.json": manifest("^0.24.0"), "src/a.ts": USES, "prompts/agent.md": `Rules:\n${wrapped}\n` },
      [QUOTED],
    );
    expect(result.reaches.some((r) => r.kind === "stale_quote")).toBe(true);
  });

  it("says nothing when the sentence is not in the repo", () => {
    const result = scan({ "package.json": manifest("^0.24.0"), "src/a.ts": USES }, [QUOTED]);
    expect(result.reaches.some((r) => r.kind === "stale_quote")).toBe(false);
  });

  /**
   * The floor is the whole reason this reach can be trusted. A short fragment
   * appears in every repository by accident, and reporting one as evidence
   * would turn the strongest line in the layer into the noisiest.
   */
  it("refuses a fragment too short to be distinctive", () => {
    const short: BlastTarget = { label: "make_thing", surface: "./ai-sdk", tool: "make_thing", quotes: ["the request"] };
    const result = scan(
      { "package.json": manifest("^0.24.0"), "src/a.ts": USES, "prompts/agent.md": "about the request itself" },
      [short],
    );
    expect(result.reaches.some((r) => r.kind === "stale_quote")).toBe(false);
  });

  it("ranks above a word match on the same tool", () => {
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "prompts/agent.md": SENTENCE,
      },
      [QUOTED],
    );
    const kinds = result.reaches.map((r) => r.kind);
    expect(kinds.indexOf("stale_quote")).toBeLessThan(kinds.indexOf("tool_reference"));
  });
});

/**
 * The reach that makes an HTTP API reachable at all.
 *
 * Every other kind here assumes the contract and the consumer's code agree on
 * what a thing is called. For a package they do. For an API they never do.
 */
describe("endpoint_reference", () => {
  const ENDPOINT: BlastTarget = {
    label: "PostAccountSessions",
    surface: "spec.json",
    tool: "PostAccountSessions",
    aliases: ["/v1/account_sessions", "POST /v1/account_sessions", "accountSessions"],
  };

  const CHARGES: BlastTarget = {
    label: "GetCharges",
    surface: "spec.json",
    tool: "GetCharges",
    aliases: ["/v1/charges", "GET /v1/charges", ".charges"],
  };

  it("finds a raw HTTP call by its exact path", () => {
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "src/http.ts": 'await fetch("https://api.example.com/v1/account_sessions", { method: "POST" });',
      },
      [ENDPOINT],
    );
    const hit = result.reaches.find((r) => r.kind === "endpoint_reference");
    expect(hit?.evidence).toBe("src/http.ts:1");
    expect(hit?.detail).toContain("names `/v1/account_sessions`");
  });

  it("finds an SDK call by the resource, and says that is what it found", () => {
    // The consumer writes `stripe.accountSessions.create`, which contains no
    // path and no operationId. The resource is all there is, and the detail has
    // to say so rather than implying the exact endpoint was matched.
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "src/sdk.ts": "await stripe.accountSessions.create({ account });",
      },
      [ENDPOINT],
    );
    const hit = result.reaches.find((r) => r.kind === "endpoint_reference");
    expect(hit?.evidence).toBe("src/sdk.ts:1");
    expect(hit?.detail).toContain("resource this operation belongs to");
  });

  /**
   * Measured, not assumed. A substring match pulled twenty-five billing
   * endpoints into a project that only touches the portal, because `.billing`
   * sits inside `.billingPortal`.
   */
  it("does not match a resource that is only a prefix of another", () => {
    const BILLING: BlastTarget = {
      label: "GetBillingAlerts",
      surface: "spec.json",
      tool: "GetBillingAlerts",
      aliases: ["/v1/billing/alerts", ".billing"],
    };
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "src/sdk.ts": "await stripe.billingPortal.sessions.create({ customer });",
      },
      [BILLING],
    );
    expect(result.reaches.some((r) => r.kind === "endpoint_reference")).toBe(false);
  });

  it("does not match an ordinary English word in a comment", () => {
    // The control that decides whether this reach can be believed at all.
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "src/note.ts": "// this charges the customer and creates an invoice\n",
      },
      [CHARGES],
    );
    expect(result.reaches.some((r) => r.kind === "endpoint_reference")).toBe(false);
  });

  it("does not anchor on a prose file", () => {
    // A README documenting an endpoint is documentation, not a line that stops
    // working. Same rule as `tool_reference`.
    const result = scan(
      {
        "package.json": manifest("^0.24.0"),
        "src/a.ts": USES,
        "docs/api.md": "Call `/v1/account_sessions` to open the dashboard.",
      },
      [ENDPOINT],
    );
    expect(result.reaches.every((r) => !r.evidence.startsWith("docs/"))).toBe(true);
  });

  it("says nothing about a target with no aliases", () => {
    const result = scan({ "package.json": manifest("^0.24.0"), "src/a.ts": USES });
    expect(result.reaches.some((r) => r.kind === "endpoint_reference")).toBe(false);
  });
});

/**
 * The manifest gate is right for a package and wrong for an API.
 *
 * This is the bug that nearly shipped. Applying the dependency check to an HTTP
 * contract filtered every finding as `not_a_dependency` before one file was
 * read — a confident "nothing reaches you" about a repository that was never
 * scanned, which is the exact claim this layer must never make.
 */
describe("how a contract is distributed", () => {
  const ENDPOINT: BlastTarget = {
    label: "PostAccountSessions",
    surface: "spec.json",
    tool: "PostAccountSessions",
    aliases: ["/v1/account_sessions"],
  };

  const files = {
    // A real manifest that quite correctly says nothing about an HTTP API.
    "package.json": JSON.stringify({ name: "shop", dependencies: { react: "^19.0.0" } }),
    "src/billing.ts": 'await fetch("https://api.example.com/v1/account_sessions");',
  };

  it("scans the repo for an http contract, which no manifest can declare", () => {
    const result = blastRadius({
      repo: repo(files),
      package: "example-api",
      ecosystem: "http",
      affectedVersions: ["after"],
      targets: [ENDPOINT],
    });

    expect(result.reaches.some((r) => r.kind === "endpoint_reference")).toBe(true);
    // No dependency claim in either direction: there is no manifest entry that
    // could have existed, so its absence narrows nothing.
    expect(result.filtered).toEqual([]);
    expect(result.reaches.some((r) => r.kind === "dependency")).toBe(false);
  });

  it("still applies the gate to a package, where it is evidence", () => {
    const result = blastRadius({
      repo: repo(files),
      package: "example-api",
      affectedVersions: ["1.0.0"],
      targets: [ENDPOINT],
    });

    expect(result.filtered.map((f) => f.kind)).toEqual(["not_a_dependency"]);
    expect(result.reaches).toEqual([]);
  });
});
