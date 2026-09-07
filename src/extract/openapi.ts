/**
 * OpenAPI as a tool contract — spec §10 step 4, and the last unbuilt reader.
 *
 * The product has been npm-package and manifest shaped, which covers the tools
 * a package ships and the tools a host writes out. It missed the third and
 * largest producer: an HTTP API whose operations are handed to a model by a
 * generator. Every one of those generators does the same thing — one operation
 * becomes one tool, `summary` and `description` become the prose the model
 * reads, and the parameters become the schema. So an OpenAPI document *is* a
 * tool contract, one transformation earlier.
 *
 * **This is not an oasdiff.** Comparing two specs field by field is a solved
 * problem and several tools do it well. The question here is the one none of
 * them ask: a deleted `summary` breaks no client, passes every contract test,
 * and changes what the model does. That is a Layer 1 finding, and it needs the
 * spec normalized into a contract rather than diffed as a document.
 *
 * Deliberately a *shape*, not a pipeline. It produces the same descriptor
 * records the manifest reader already takes, so an OpenAPI document goes
 * through the identical extractor, the identical four layers and the identical
 * verdict. No second implementation of anything.
 */

type Json = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Follow a local `$ref`.
 *
 * `#/components/schemas/Candidate` and nothing else. An external or remote ref
 * is left exactly as it is: fetching it would put this reader on the network,
 * and inventing a shape for it would be worse. Downstream it reads as a
 * parameter whose type is unknown, which is true.
 */
function deref(node: unknown, root: Json, seen = new Set<string>()): unknown {
  if (!isObject(node)) return node;
  const ref = node["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  if (seen.has(ref)) return node;
  seen.add(ref);

  let cursor: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(cursor)) return node;
    cursor = cursor[key];
  }
  return cursor === undefined ? node : deref(cursor, root, seen);
}

/**
 * What a generator calls this operation.
 *
 * `operationId` when the spec has one, which is what every generator prefers.
 * Without it the name is synthesized from the method and path, the way the
 * generators do when they have nothing else. A synthesized name may not match
 * the exact string some particular generator would produce, but both sides of a
 * comparison are synthesized the same way, so the diff stays sound: what is
 * being compared is the operation, and the name is how it is addressed.
 */
function operationName(method: string, path: string, operation: Json): string {
  const id = operation["operationId"];
  if (typeof id === "string" && id.length > 0) return id;
  const slug = path
    .replace(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .join("_");
  return slug.length === 0 ? method : `${method}_${slug}`;
}

/**
 * The prose the model is given.
 *
 * `summary` and `description` joined, because a generator concatenates them and
 * a model receives one string. Comparing them separately would report two
 * findings for one sentence moving between the fields.
 */
function prose(operation: Json): string | null {
  const parts = [operation["summary"], operation["description"]]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length === 0 ? null : [...new Set(parts)].join("\n\n");
}

function schemaOfParameter(parameter: Json, root: Json): Json {
  const schema = deref(parameter["schema"], root);
  const base: Json = isObject(schema) ? { ...schema } : {};
  // The parameter's own description wins over the schema's. It is the one
  // written about this use of the type, and it is what a generator passes on.
  const description = parameter["description"];
  if (typeof description === "string" && description.length > 0) base["description"] = description;
  return base;
}

/**
 * One operation as a JSON Schema of its arguments.
 *
 * Path, query and header parameters become top-level fields, which is what a
 * generator produces. The request body becomes one `body` field with the schema
 * nested under it rather than spread across the top level: spreading it would
 * make a body property and a query parameter of the same name collide silently,
 * and a silently merged parameter is a false statement about the contract.
 */
function inputSchemaFor(operation: Json, shared: unknown, root: Json): Json {
  const properties: Json = {};
  const required: string[] = [];

  const parameters = [...(Array.isArray(shared) ? shared : []), ...(Array.isArray(operation["parameters"]) ? operation["parameters"] : [])];
  for (const entry of parameters) {
    const parameter = deref(entry, root);
    if (!isObject(parameter)) continue;
    const name = parameter["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    // `cookie` parameters are transport, never something a model fills.
    if (parameter["in"] === "cookie") continue;
    properties[name] = schemaOfParameter(parameter, root);
    if (parameter["required"] === true) required.push(name);
  }

  const body = deref(operation["requestBody"], root);
  if (isObject(body)) {
    const content = body["content"];
    const json = isObject(content)
      ? (content["application/json"] ?? Object.values(content).find((entry) => isObject(entry)))
      : undefined;
    const schema = isObject(json) ? deref(json["schema"], root) : undefined;
    if (isObject(schema)) {
      const described = body["description"];
      properties["body"] = typeof described === "string" && described.length > 0
        ? { ...schema, description: described }
        : schema;
      if (body["required"] === true) required.push("body");
    }
  }

  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * Read an OpenAPI document as a list of tool descriptors, or null when it is
 * not one.
 *
 * Null rather than an empty list for a document that is not a spec at all: the
 * caller falls through to its other shapes, and an empty list from here would
 * claim a spec that declares no operations.
 */
export function openApiToolList(root: unknown): unknown[] | null {
  if (!isObject(root)) return null;
  const version = root["openapi"] ?? root["swagger"];
  if (typeof version !== "string") return null;
  const paths = root["paths"];
  if (!isObject(paths)) return null;

  const tools: unknown[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const entry = deref(item, root);
    if (!isObject(entry)) continue;
    for (const method of METHODS) {
      const operation = entry[method];
      if (!isObject(operation)) continue;
      tools.push({
        name: operationName(method, path, operation),
        description: prose(operation),
        inputSchema: inputSchemaFor(operation, entry["parameters"], root),
      });
    }
  }

  return tools.length === 0 ? null : tools;
}
