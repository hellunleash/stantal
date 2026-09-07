import { describe, expect, it } from "vitest";
import { callsOf, ranked, readTraces } from "./otel.js";

/** OTLP as a collector writes it: attributes as `[{key, value}]`, values typed. */
function otlp(spans: Array<{ name: string; attributes: Record<string, string> }>): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
        scopeSpans: [
          {
            spans: spans.map((span) => ({
              name: span.name,
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: { stringValue: value },
              })),
            })),
          },
        ],
      },
    ],
  });
}

describe("reading a trace export", () => {
  it("counts calls by tool name", () => {
    const profile = readTraces(
      otlp([
        { name: "execute_tool make_thing", attributes: { "gen_ai.tool.name": "make_thing" } },
        { name: "execute_tool make_thing", attributes: { "gen_ai.tool.name": "make_thing" } },
        { name: "execute_tool delegate_task", attributes: { "gen_ai.tool.name": "delegate_task" } },
        { name: "chat gpt-5.4", attributes: { "gen_ai.operation.name": "chat" } },
      ]),
      "traces.json",
    );

    expect(profile.spans).toBe(4);
    expect(callsOf(profile, "make_thing")).toBe(2);
    expect(callsOf(profile, "delegate_task")).toBe(1);
    // Never mentioned. Zero, and the caller must not read that as "unused".
    expect(callsOf(profile, "create_thing")).toBe(0);
    expect(ranked(profile)[0]?.tool).toBe("make_thing");
  });

  it("reads the span name only when the operation says it is a tool call", () => {
    // Guessing a tool out of an arbitrary span name would invent usage, which
    // is the one thing a layer built on evidence must not do.
    const profile = readTraces(
      otlp([
        { name: "execute_tool search", attributes: { "gen_ai.operation.name": "execute_tool" } },
        { name: "execute_tool other", attributes: {} },
      ]),
      "traces.json",
    );
    expect(callsOf(profile, "search")).toBe(1);
    expect(callsOf(profile, "other")).toBe(0);
  });

  it("accepts attributes as a plain object, which is what most SDKs write", () => {
    const profile = readTraces(
      JSON.stringify([{ name: "tool", attributes: { "mcp.tool.name": "tavily_search" } }]),
      "spans.json",
    );
    expect(callsOf(profile, "tavily_search")).toBe(1);
  });

  it("accepts newline-delimited spans, and notes the lines it could not read", () => {
    const good = JSON.stringify({ name: "t", attributes: { "tool.name": "a" } });
    const profile = readTraces(`${good}\nnot json\n${good}\n`, "spans.ndjson");
    expect(callsOf(profile, "a")).toBe(2);
    expect(profile.notes.some((n) => n.includes("were not JSON"))).toBe(true);
  });

  it("records which arguments were actually supplied", () => {
    const profile = readTraces(
      otlp([
        {
          name: "t",
          attributes: {
            "gen_ai.tool.name": "make_thing",
            "gen_ai.tool.call.arguments": JSON.stringify({ request: "build a thing", app: "fitness tracker" }),
          },
        },
        {
          name: "t",
          attributes: { "gen_ai.tool.name": "make_thing", "gen_ai.tool.call.arguments": JSON.stringify({ request: "x" }) },
        },
      ]),
      "traces.json",
    );
    expect(profile.byTool["make_thing"]?.params).toEqual({ request: 2, app: 1 });
  });
});

describe("what it says when it cannot say much", () => {
  it("says so when spans were read and none named a tool", () => {
    // Silence here is indistinguishable from an agent that called nothing, and
    // the likelier cause is an exporter naming tools somewhere we do not look.
    const profile = readTraces(otlp([{ name: "chat", attributes: { "gen_ai.operation.name": "chat" } }]), "t.json");
    expect(profile.notes.some((n) => n.includes("none naming a tool"))).toBe(true);
  });

  it("does not pretend an empty or unreadable file is an empty trace", () => {
    expect(readTraces("", "t.json").notes).toHaveLength(1);
    expect(readTraces("<html>nope</html>", "t.json").notes[0]).toContain("not JSON");
  });
});
