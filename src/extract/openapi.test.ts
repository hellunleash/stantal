import { describe, expect, it } from "vitest";
import { extractFromManifest } from "./manifest.js";
import { openApiToolList } from "./openapi.js";
import { isPresent } from "../contract/surface.js";

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Hiring", version: "1.0.0" },
  paths: {
    "/candidates/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, description: "The candidate id.", schema: { type: "string" } },
      ],
      get: {
        operationId: "get_candidate",
        summary: "Fetch one candidate.",
        description: "Pass the candidate's id, not their email address.",
        parameters: [{ name: "include", in: "query", schema: { type: "string" } }],
      },
    },
    "/candidates": {
      post: {
        summary: "Create a candidate.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewCandidate" },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      NewCandidate: {
        type: "object",
        properties: { name: { type: "string", description: "Full name." } },
        required: ["name"],
      },
    },
  },
};

function contractOf(spec: unknown) {
  const result = extractFromManifest({ text: JSON.stringify(spec), package: "hiring", version: "1.0.0" });
  if (!isPresent(result)) throw new Error(`absent: ${result.absence.reason}`);
  return result.contract;
}

describe("an OpenAPI document is a tool contract", () => {
  it("reads one tool per operation, through the ordinary manifest path", () => {
    const contract = contractOf(SPEC);
    expect(contract.tools.map((t) => t.name).sort()).toEqual(["get_candidate", "post_candidates"]);
  });

  it("joins summary and description, because a generator hands the model one string", () => {
    const tool = contractOf(SPEC).tools.find((t) => t.name === "get_candidate");
    expect(tool?.description).toBe("Fetch one candidate.\n\nPass the candidate's id, not their email address.");
  });

  it("takes path-level parameters as well as the operation's own", () => {
    const tool = contractOf(SPEC).tools.find((t) => t.name === "get_candidate");
    const id = tool?.params.find((p) => p.name === "id");
    expect(id?.required).toBe(true);
    expect(id?.description).toBe("The candidate id.");
    // Optional, undescribed: exactly the shape Layer 1 raises a finding about.
    expect(tool?.params.find((p) => p.name === "include")?.required).toBe(false);
  });

  it("nests the request body rather than spreading it", () => {
    // Spreading a body property alongside a query parameter of the same name
    // merges two different fields silently, which is a false statement about
    // the contract in the layer that reports parameter changes.
    const tool = contractOf(SPEC).tools.find((t) => t.name === "post_candidates");
    const body = tool?.params.find((p) => p.name === "body");
    expect(body?.required).toBe(true);
    expect(body?.children?.map((c) => c.name)).toEqual(["name"]);
  });

  it("names an operation with no operationId after its method and path", () => {
    const tools = openApiToolList(SPEC) as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "post_candidates")).toBe(true);
  });

  it("leaves a remote $ref alone rather than guessing at it", () => {
    // Fetching it would put this reader on the network; inventing a shape for
    // it would be worse than reporting a parameter whose type is unknown.
    const tools = openApiToolList({
      openapi: "3.0.0",
      paths: {
        "/x": {
          post: {
            operationId: "x",
            requestBody: { content: { "application/json": { schema: { $ref: "https://example.com/s.json" } } } },
          },
        },
      },
    }) as Array<{ inputSchema: { properties: Record<string, unknown> } }>;
    expect(tools[0]?.inputSchema.properties["body"]).toEqual({ $ref: "https://example.com/s.json" });
  });

  it("is not confused by a document that is not a spec", () => {
    expect(openApiToolList({ tools: [{ name: "a" }] })).toBeNull();
    expect(openApiToolList({ openapi: "3.1.0" })).toBeNull();
    // Declares itself a spec and has no operations. Null, so the caller falls
    // through instead of reporting a contract with every tool removed.
    expect(openApiToolList({ openapi: "3.1.0", paths: {} })).toBeNull();
  });
});
