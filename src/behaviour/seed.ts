import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Contract } from "../contract/types.js";
import { presentTool, type CallRequest, type ToolCaller, type Turn } from "./caller.js";
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
  /**
   * Requests that continue a conversation instead of starting one.
   *
   * These are the only ones that can catch a model filling an optional field
   * with something it learned earlier in the session. A corpus of first turns
   * cannot produce that at all: on turn one there is nothing to fill it with,
   * so leaving it out is correct and the run comes back clean.
   */
  conversations?: number;
  cacheDir?: string;
};

export const DEFAULT_PER_TOOL = 3;
export const DEFAULT_CONTROLS = 2;
export const DEFAULT_CONVERSATIONS = 3;
export const DEFAULT_SEED_CACHE_DIR = ".stantal/intents";

/**
 * The tool the model is made to call in order to answer.
 *
 * A schema, not a prose instruction, because the reply has to parse. This is
 * the same trick the judge uses for the same reason.
 */
function proposalTool(
  toolNames: readonly string[],
  perTool: number,
  controls: number,
  conversations: number,
) {
  return {
    name: "propose_intents",
    description: [
      `Propose realistic user requests for an assistant that has these tools: ${toolNames.join(", ")}.`,
      `Give ${perTool} requests per tool, phrased the way a real user would type them —`,
      "no tool names, no parameter names, no API vocabulary.",
      `Then give ${conversations} requests that continue a conversation already under way:`,
      "fill `history` with the turns that came before, and make the final request refer back",
      "to something established there — a name, a title, an id — the way a real user would",
      "when they are still talking about the thing they just made.",
      "These should still reach a tool. Set expectsNoCall to false and tag them like any other.",
      `Then, separately, give ${controls} requests that none of these tools should be used for`,
      "at all. Those are the only ones with expectsNoCall true, and they have no history.",
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
                description:
                  "True only when none of the tools fits this request. This is about fit, not about position in a conversation — a follow-up that still needs a tool is false.",
              },
              history: {
                type: "array",
                description:
                  "Turns that came before this request, oldest first. Omit for a first-turn request.",
                items: {
                  type: "object",
                  properties: {
                    user: { type: "string", description: "What the user said on this turn." },
                    tool: {
                      type: "string",
                      description: "The tool the assistant called in reply, if it called one.",
                    },
                    arguments: {
                      type: "object",
                      description: "The arguments it called that tool with.",
                    },
                    result: {
                      type: "string",
                      description:
                        "What that tool returned, in one short sentence. Name anything the user might refer to later.",
                    },
                  },
                  required: ["user"],
                },
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

type ProposedTurn = {
  user: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: string;
};

type Proposed = {
  text: string;
  tools: string[];
  expectsNoCall: boolean;
  history: ProposedTurn[];
};

function parseHistory(value: unknown): ProposedTurn[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): ProposedTurn[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { user, tool, arguments: args, result } = entry as Record<string, unknown>;
    // A turn with nothing said on it carries nothing for the follow-up to
    // refer back to, which is the only reason history exists here.
    if (typeof user !== "string" || user.trim().length === 0) return [];

    const usableArgs =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : undefined;

    return [
      {
        user: user.trim(),
        ...(typeof tool === "string" && tool.length > 0 ? { tool } : {}),
        ...(usableArgs === undefined ? {} : { arguments: usableArgs }),
        ...(typeof result === "string" && result.length > 0 ? { result } : {}),
      },
    ];
  });
}

function parseProposals(value: unknown): Proposed[] {
  const list = (value as { intents?: unknown }).intents;
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry): Proposed[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { text, tools, expectsNoCall, history } = entry as Record<string, unknown>;
    if (typeof text !== "string" || text.trim().length === 0) return [];
    return [
      {
        text: text.trim(),
        tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [],
        expectsNoCall: expectsNoCall === true,
        history: parseHistory(history),
      },
    ];
  });
}

/**
 * A proposed conversation, turned into turns the wire understands.
 *
 * A tool the anchor does not declare is a hallucination, handled the same way
 * as a hallucinated slice tag: the call is dropped and the user turn kept. The
 * user turn is the half that carries whatever the follow-up refers back to, so
 * dropping the whole entry would throw away the point of the intent to punish
 * a detail that is not measured.
 */
function turnsFor(history: readonly ProposedTurn[], known: ReadonlySet<string>): Turn[] {
  const out: Turn[] = [];

  for (const entry of history) {
    out.push({ role: "user", text: entry.user });
    if (entry.tool === undefined || !known.has(entry.tool)) continue;
    out.push({
      role: "call",
      tool: entry.tool,
      arguments: entry.arguments ?? {},
      // A call with no stated result still happened. "Done." keeps the shape
      // intact without inventing a fact the follow-up could refer to.
      result: entry.result ?? "Done.",
    });
  }

  return out;
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
  const conversations = options.conversations ?? DEFAULT_CONVERSATIONS;
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
    tools: [proposalTool(toolNames, perTool, controls, conversations)],
  };

  const hash = seedHash(options.caller.id, request);
  const path = cachePath(dir, options.anchor, hash);

  const cached = readCached(path);
  if (cached !== null) return cached;

  const choice = await options.caller.call(request);
  if (choice.kind !== "tool_call") return [];

  const proposed = parseProposals(choice.arguments);
  const known = new Set(toolNames);

  const intents = proposed.map((entry, index): Intent => {
    const history = turnsFor(entry.history, known);
    return {
      id: `seed-${index + 1}`,
      text: entry.text,
      // Spread in only when there is something to carry, so a first-turn intent
      // serializes exactly as it did before conversations existed and keeps
      // every cassette already recorded for it.
      ...(history.length > 0 ? { history } : {}),
      // A tool the anchor does not declare is a hallucinated slice tag. Dropping
      // it leaves the intent untagged, which makes it always run — the safe
      // direction, since an untagged intent is unknown rather than cheap.
      slice: entry.expectsNoCall ? [] : entry.tools.filter((t) => known.has(t)),
      expectsNoCall: entry.expectsNoCall,
    };
  });

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
