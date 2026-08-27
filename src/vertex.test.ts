import { describe, expect, test } from "vitest";
import { DEFAULT_VERTEX_LOCATION, vertexFromEnv, vertexLocation, vertexUrl } from "./vertex.js";

const project = { project: "example-project" };

describe("which publisher a model belongs to", () => {
  test("google models answer generateContent", () => {
    const url = vertexUrl(project, "gemini-3.6-flash");
    expect(url).toContain("/publishers/google/models/gemini-3.6-flash:generateContent");
  });

  test("a partner model answers rawPredict", () => {
    // A partner model is passed through in its vendor's own format, so the
    // body is Anthropic's rather than Vertex's and the method differs.
    const url = vertexUrl(project, "claude-opus-5", "anthropic");
    expect(url).toContain("/publishers/anthropic/models/claude-opus-5:rawPredict");
  });
});

describe("where each publisher's models live", () => {
  test("google defaults to global, which has no region prefix", () => {
    expect(vertexLocation(project)).toBe(DEFAULT_VERTEX_LOCATION);
    expect(vertexUrl(project, "gemini-3.6-flash").startsWith("https://aiplatform.googleapis.com/")).toBe(true);
  });

  test("anthropic defaults to a region, because it is not served from global", () => {
    // Measured against the live API: listing anthropic publisher models at
    // `global` returns an HTML error page, while us-central1 returns eleven
    // models including the two this project defaults to.
    expect(vertexLocation(project, "anthropic")).toBe("us-central1");
    expect(
      vertexUrl(project, "claude-opus-5", "anthropic").startsWith("https://us-central1-aiplatform.googleapis.com/"),
    ).toBe(true);
  });

  test("an explicit global is corrected for anthropic rather than honoured", () => {
    // A single default location is wrong for one publisher whichever value it
    // takes. `global` cannot work for anthropic, so honouring it would turn a
    // setting somebody made for gemini into a 404 they cannot explain.
    const config = { ...project, location: "global" };
    expect(vertexLocation(config, "anthropic")).toBe("us-central1");
    expect(vertexLocation(config, "google")).toBe("global");
  });

  test("any other explicit location is honoured for both", () => {
    const config = { ...project, location: "europe-west1" };
    expect(vertexLocation(config, "google")).toBe("europe-west1");
    expect(vertexLocation(config, "anthropic")).toBe("europe-west1");
  });
});

describe("the project is read from the environment", () => {
  test("no project means no vertex", () => {
    expect(vertexFromEnv({})).toBeNull();
    expect(vertexFromEnv({ STANTAL_VERTEX_PROJECT: "" })).toBeNull();
  });

  test("a project is enough; location is optional", () => {
    expect(vertexFromEnv({ STANTAL_VERTEX_PROJECT: "p" })).toEqual({ project: "p" });
    expect(vertexFromEnv({ STANTAL_VERTEX_PROJECT: "p", STANTAL_VERTEX_LOCATION: "us-east5" })).toEqual({
      project: "p",
      location: "us-east5",
    });
  });
});

describe("values that would break a URL are encoded", () => {
  test("project and model are escaped", () => {
    const url = vertexUrl({ project: "a b/c" }, "m o/d", "anthropic");
    expect(url).toContain("projects/a%20b%2Fc");
    expect(url).toContain("models/m%20o%2Fd:rawPredict");
  });
});
