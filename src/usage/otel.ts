/**
 * Usage weighting from traces — spec §10 step 13.
 *
 * Every layer above this one reasons about what *could* happen: the contract
 * changed, a model would read it differently, the repo imports the door. A
 * trace records what did happen. Which tools an agent actually called is the
 * only blast-radius signal that is not inference, and it is the honest fix for
 * the layer's weakest case — a contract whose caller is the model, where no
 * source file names the tool and static reading has nothing to point at.
 *
 * **OpenTelemetry rather than any one vendor.** Traces are the one thing every
 * agent stack already emits, and the GenAI semantic conventions name the tool
 * in an attribute. Reading OTLP means Langfuse, Braintrust, Phoenix, Honeycomb
 * and a plain file exporter all work with no adapter, and nothing here is
 * coupled to a product that may be gone in a year.
 *
 * **Additive, never subtractive.** A tool the traces never mention is not a
 * tool nobody calls: it is a tool nobody called in the window that was
 * exported. So observed usage can raise a finding and can never retire one.
 * Getting this backwards would let a short trace file silence a real finding,
 * which is the exact false clearance this project exists to prevent.
 */

export type ToolUsage = {
  tool: string;
  calls: number;
  /** How often each argument was actually supplied. Empty when arguments were not recorded. */
  params: Record<string, number>;
};

export type UsageProfile = {
  /** Where this came from, quoted as evidence: a filename, an exporter, a query. */
  source: string;
  /** Spans read, including ones that named no tool. The denominator of the claim. */
  spans: number;
  byTool: Record<string, ToolUsage>;
  /** Documents or spans that could not be read. A gap, never "no usage". */
  notes: string[];
};

/**
 * Attributes that carry the tool's name.
 *
 * `gen_ai.tool.name` is the semantic convention. The rest are what real
 * instrumentation emitted before it settled, and they cost one array entry
 * each. A stale list of names is a failure this product exists to catch, so
 * this is a list of things to accept, never a list of things to reject: an
 * unrecognised span contributes nothing and is not an error.
 */
const TOOL_NAME_KEYS = [
  "gen_ai.tool.name",
  "mcp.tool.name",
  "tool.name",
  "llm.tool.name",
  "traceloop.entity.name",
];

/** Attributes that carry the call's arguments, as a JSON object. */
const ARGUMENT_KEYS = ["gen_ai.tool.call.arguments", "mcp.request.arguments", "tool.arguments", "input.value"];

type AnyValue = Record<string, unknown>;

/** OTLP wraps every value in a one-key object naming its type. */
function plain(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as AnyValue;
  if ("stringValue" in v) return v["stringValue"];
  if ("intValue" in v) return Number(v["intValue"]);
  if ("doubleValue" in v) return v["doubleValue"];
  if ("boolValue" in v) return v["boolValue"];
  if ("arrayValue" in v) {
    const inner = (v["arrayValue"] as AnyValue | undefined)?.["values"];
    return Array.isArray(inner) ? inner.map(plain) : [];
  }
  return value;
}

/**
 * A span's attributes as a flat map.
 *
 * OTLP writes them as `[{key, value}]` and most SDKs' own JSON writes them as
 * an object. Both are accepted: a person exporting a trace should not have to
 * know which shape their exporter chose.
 */
function attributesOf(span: AnyValue): Record<string, unknown> {
  const raw = span["attributes"];
  const out: Record<string, unknown> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const key = (entry as AnyValue)["key"];
      if (typeof key === "string") out[key] = plain((entry as AnyValue)["value"]);
    }
  } else if (typeof raw === "object" && raw !== null) {
    for (const [key, value] of Object.entries(raw as AnyValue)) out[key] = plain(value);
  }
  return out;
}

function toolNameOf(span: AnyValue, attributes: Record<string, unknown>): string | null {
  for (const key of TOOL_NAME_KEYS) {
    const value = attributes[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  // The convention names the span `execute_tool <name>` when the operation is a
  // tool call. Used only when the operation says so, never on the name alone:
  // guessing a tool out of an arbitrary span name would invent usage.
  const operation = attributes["gen_ai.operation.name"];
  const name = span["name"];
  if (operation === "execute_tool" && typeof name === "string") {
    const rest = name.slice("execute_tool".length).trim();
    if (rest.length > 0) return rest;
  }
  return null;
}

function argumentsOf(attributes: Record<string, unknown>): string[] {
  for (const key of ARGUMENT_KEYS) {
    const value = attributes[key];
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return Object.keys(parsed);
    } catch {
      // Arguments we could not parse tell us nothing about which fields were
      // filled. The call still counts; only the field detail is lost.
      return [];
    }
  }
  return [];
}

/** Every span in a document, whatever nesting the exporter chose. */
function spansIn(root: unknown, into: AnyValue[]): void {
  if (Array.isArray(root)) {
    for (const entry of root) spansIn(entry, into);
    return;
  }
  if (typeof root !== "object" || root === null) return;
  const node = root as AnyValue;

  if (Array.isArray(node["resourceSpans"])) return spansIn(node["resourceSpans"], into);
  if (Array.isArray(node["scopeSpans"])) return spansIn(node["scopeSpans"], into);
  // The pre-1.0 name, still emitted by older collectors.
  if (Array.isArray(node["instrumentationLibrarySpans"])) return spansIn(node["instrumentationLibrarySpans"], into);
  if (Array.isArray(node["spans"])) {
    for (const span of node["spans"]) {
      if (typeof span === "object" && span !== null) into.push(span as AnyValue);
    }
    return;
  }
  // A bare span, which is what a one-span-per-line export writes.
  if (typeof node["name"] === "string" || node["attributes"] !== undefined) into.push(node);
}

/**
 * Read a trace export into a usage profile.
 *
 * Accepts one OTLP document, an array of spans, or newline-delimited JSON of
 * either — the three shapes an exporter, a collector and a `jq` pipeline
 * produce. Nothing is fetched: the caller hands over text, so this works
 * against a file dropped next to the repo and needs no credential.
 */
export function readTraces(text: string, source: string): UsageProfile {
  const profile: UsageProfile = { source, spans: 0, byTool: {}, notes: [] };

  const documents: unknown[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    profile.notes.push(`${source} is empty`);
    return profile;
  }

  try {
    documents.push(JSON.parse(trimmed));
  } catch {
    // Newline-delimited, which is how a file exporter and most log pipelines
    // write traces. Each bad line is a note rather than a failure: a truncated
    // last line is normal in a file still being written to.
    let bad = 0;
    for (const line of trimmed.split("\n")) {
      const one = line.trim();
      if (one.length === 0) continue;
      try {
        documents.push(JSON.parse(one));
      } catch {
        bad += 1;
      }
    }
    if (documents.length === 0) {
      profile.notes.push(`${source} is not JSON or newline-delimited JSON`);
      return profile;
    }
    if (bad > 0) profile.notes.push(`${bad} line(s) of ${source} were not JSON and were skipped`);
  }

  const spans: AnyValue[] = [];
  for (const document of documents) spansIn(document, spans);
  profile.spans = spans.length;

  for (const span of spans) {
    const attributes = attributesOf(span);
    const tool = toolNameOf(span, attributes);
    if (tool === null) continue;

    const row = profile.byTool[tool] ?? { tool, calls: 0, params: {} };
    row.calls += 1;
    for (const name of argumentsOf(attributes)) row.params[name] = (row.params[name] ?? 0) + 1;
    profile.byTool[tool] = row;
  }

  if (profile.spans > 0 && Object.keys(profile.byTool).length === 0) {
    // Read, and nothing in it named a tool. Worth saying: the likeliest cause
    // is an exporter that names tools somewhere this does not look, and silence
    // there is indistinguishable from an agent that called nothing.
    profile.notes.push(`${profile.spans} span(s) in ${source}, none naming a tool`);
  }

  return profile;
}

/** How often a tool was called, or 0 when the traces never mention it. */
export function callsOf(profile: UsageProfile, tool: string): number {
  return profile.byTool[tool]?.calls ?? 0;
}

/** Tools by how often they were called, most-used first. */
export function ranked(profile: UsageProfile): ToolUsage[] {
  return Object.values(profile.byTool).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}
