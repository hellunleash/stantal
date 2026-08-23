import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Contract } from "../contract/types.js";
import { presentTool, type CallRequest, type ToolCaller } from "./caller.js";
import type { Intent } from "./intent.js";

/**
 * Seed intents: what to ask, before any real traffic exists.
 *
 * The spec's plan is seed now, harvest later — real intents arrive once hosts
 * instrument, and until then the corpus is derived from the package itself.
 * That derivation has one hard constraint, and it is the reason this module is
 * separate from the runner:
 *
 * **Seeds are generated from an anchor version and never from the pair under
 * test.** Generate them from the newer contract and the request will have been
 * written against the prose being evaluated, so the model looks good on it for
 * a reason that has nothing to do with the package. The measurement would be
 * circular and every number it produced would be worthless.
 *
 * The anchor is the oldest version walked. It predates whatever the diff is
 * about, which is exactly the property wanted: it describes what the user was
 * already trying to do.
 *
 * Generation reuses the tool-calling caller rather than adding a second wire
 * format. Asking for structured output through a tool the model must call is
 * both fewer moving parts and better-formed output than asking for JSON in
 * prose.
 */

export type SeedOptions = {
  /** The anchor contract. Must not be the newer side of the pair being tested. */
  anchor: Contract;
  caller: ToolCaller;
  /** Requests per tool. */
  perTool?: number;
  /** Requests that should reach no tool at all — the false-positive control. */
  controls?: number;
  cacheDir?: string;
};

export const DEFAULT_PER_TOOL = 3;
export const DEFAULT_CONTROLS = 2;
export const DEFAULT_SEED_CACHE_DIR = ".stantal/intents";

/**
 * The tool the model is made to call in order to answer.
 *
 * A schema, not a prose instruction, because the reply has to parse. This is
 * the same trick the judge uses for the same reason.
 */
function proposalTool(toolNames: readonly string[], perTool: number, controls: number) {
  return {
    name: "propose_intents",
    description: [
      `Propose realistic user requests for an assistant that has these tools: ${toolNames.join(", ")}.`,
      `Give ${perTool} requests per tool, phrased the way a real user would type them —`,
      "no tool names, no parameter names, no API vocabulary.",
      `Then give ${controls} requests that none of these tools should be used for at all.`,
    ].join(" "),
    inputSchema: {
      type: "object" as const,
      properties: {
        intents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The user's request, in their own words." },
              tools: {
                type: "array",
                items: { type: "string" },
                description: "Which of the listed tools this request could plausibly reach. Empty for a control.",
              },
              expectsNoCall: {
                type: "boolean",
                description: "True when no tool should be used for this request.",
              },
            },
            required: ["text", "tools", "expectsNoCall"],
          },
        },
      },
      required: ["intents"],
    },
  };
}

type Proposed = { text: string; tools: string[]; expectsNoCall: boolean };

function parseProposals(value: unknown): Proposed[] {
  const list = (value as { intents?: unknown }).intents;
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry): Proposed[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { text, tools, expectsNoCall } = entry as Record<string, unknown>;
    if (typeof text !== "string" || text.trim().length === 0) return [];
    return [
      {
        text: text.trim(),
        tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [],
        expectsNoCall: expectsNoCall === true,
      },
    ];
  });
}

function seedHash(callerId: string, request: CallRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, caller: callerId, request }))
    .digest("hex");
}

function cachePath(dir: string, contract: Contract, hash: string): string {
  const name = `${contract.package}@${contract.version}`.replace(/[^a-zA-Z0-9._@-]+/g, "_");
  return join(dir, `${name}.${hash.slice(0, 16)}.json`);
}

/**
 * Intents for a package, generated once and reused across its whole history.
 *
 * Cached on disk keyed by the anchor contract, so a 40-release walk pays for
 * generation once. That is not only a cost argument: reusing one corpus is what
 * makes findings comparable across the walk at all.
 */
export async function seedIntents(options: SeedOptions): Promise<Intent[]> {
  const perTool = options.perTool ?? DEFAULT_PER_TOOL;
  const controls = options.controls ?? DEFAULT_CONTROLS;
  const dir = options.cacheDir ?? DEFAULT_SEED_CACHE_DIR;

  const toolNames = options.anchor.tools.map((t) => t.name);
  if (toolNames.length === 0) return [];

  // The anchor's tools are shown so the requests are about real capabilities.
  // Descriptions are included; parameter names are what must not leak into the
  // wording, and the prompt says so.
  const request: CallRequest = {
    intent: [
      "Propose user requests for testing an assistant that has the tools described.",
      "Call propose_intents with your answer.",
      "",
      "Tools:",
      ...options.anchor.tools.map((tool) => {
        const wire = presentTool(tool);
        return `- ${wire.name}: ${wire.description ?? "(no description)"}`;
      }),
    ].join("\n"),
    tools: [proposalTool(toolNames, perTool, controls)],
  };

  const hash = seedHash(options.caller.id, request);
  const path = cachePath(dir, options.anchor, hash);

  const cached = readCached(path);
  if (cached !== null) return cached;

  const choice = await options.caller.call(request);
  if (choice.kind !== "tool_call") return [];

  const proposed = parseProposals(choice.arguments);
  const known = new Set(toolNames);

  const intents = proposed.map((entry, index): Intent => ({
    id: `seed-${index + 1}`,
    text: entry.text,
    // A tool the anchor does not declare is a hallucinated slice tag. Dropping
    // it leaves the intent untagged, which makes it always run — the safe
    // direction, since an untagged intent is unknown rather than cheap.
    slice: entry.expectsNoCall ? [] : entry.tools.filter((t) => known.has(t)),
    expectsNoCall: entry.expectsNoCall,
  }));

  writeCached(path, intents);
  return intents;
}

function readCached(path: string): Intent[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: number; intents?: Intent[] };
    return parsed.version === 1 && Array.isArray(parsed.intents) ? parsed.intents : null;
  } catch {
    return null;
  }
}

function writeCached(path: string, intents: Intent[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, intents }, null, 2)}\n`, "utf8");
}
