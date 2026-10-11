import type { Constraints, Contract, Param, Tool } from "../contract/types.js";

/**
 * Structural diff over two normalized contracts.
 *
 * Reports what changed in the shape of a tool surface: tools and parameters
 * added or removed, types, required-ness, enums and bounds.
 *
 * `changedTools` is carried on the result so callers can narrow later work to
 * the tools that actually moved.
 */

export type StructuralRule =
  | "tool_added"
  | "tool_removed"
  | "param_added_required"
  | "param_added_optional"
  | "param_removed"
  | "param_type_changed"
  | "param_became_required"
  | "param_became_optional"
  | "constraint_tightened"
  | "constraint_relaxed"
  | "enum_narrowed"
  | "enum_widened";

/**
 * Whether a change can break a caller written against the old contract.
 *
 * Deliberately narrow: it answers a compile-time question and nothing more.
 */
const CALLER_BREAKING: ReadonlySet<StructuralRule> = new Set<StructuralRule>([
  "tool_removed",
  "param_added_required",
  "param_removed",
  "param_type_changed",
  "param_became_required",
  "constraint_tightened",
  "enum_narrowed",
]);

export type StructuralChange = {
  rule: StructuralRule;
  /** Dotted path: tool name, or `tool.param`, or `tool.param.child`. */
  target: string;
  tool: string;
  breaking: boolean;
  from?: unknown;
  to?: unknown;
  note: string;
};

export type StructuralDiff = {
  changes: StructuralChange[];
  breaking: boolean;
  /** Tools whose contract moved at all. */
  changedTools: string[];
  /**
   * Changes that were computed and are not claimed, because one side of the
   * comparison is a schema we could not read.
   *
   * Absent when there are none. `diffSurfaces` moves them into `suppressed`, so
   * they are reported as withheld rather than dropped.
   */
  withheld?: StructuralChange[];
};

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.name, i]));
}

/** Flatten nested params to dotted paths so a change three levels down is still visible. */
function flatten(params: Param[], prefix = ""): Map<string, Param> {
  const out = new Map<string, Param>();
  for (const p of params) {
    walk(p, prefix ? `${prefix}.${p.name}` : p.name, out);
  }
  return out;
}

function walk(param: Param, path: string, out: Map<string, Param>): void {
  out.set(path, param);
  if (param.children?.length) {
    for (const [k, v] of flatten(param.children, path)) out.set(k, v);
  }
  // An array's element sits on the path as `xs[]`, so its type, enum and bounds
  // go through exactly the comparisons every other parameter does.
  if (param.items !== undefined) walk(param.items, `${path}[]`, out);
}

/**
 * An array element, addressed as `xs[]`.
 *
 * Nobody passes one. It describes a parameter rather than being one, so it is
 * compared for what it holds and never reported as added or removed: an element
 * we could read on one side and not the other is a gap in our reading, and
 * "parameter `xs[]` was removed" would be that gap presented as a fact.
 */
function isElement(path: string): boolean {
  return path.endsWith("[]");
}

function enumOf(c: Constraints): string[] | null {
  if (!c.enum) return null;
  return c.enum.map((v) => JSON.stringify(v)).sort();
}

/**
 * Bounds comparison.
 *
 * "Tightened" means a value that used to be accepted now isn't. Adding a bound
 * where none existed tightens; removing one relaxes.
 */
function boundsDelta(
  from: Constraints,
  to: Constraints,
): "tightened" | "relaxed" | null {
  const lower: Array<keyof Constraints> = ["minLength", "minimum"];
  const upper: Array<keyof Constraints> = ["maxLength", "maximum"];

  let tightened = false;
  let relaxed = false;

  for (const key of lower) {
    const a = from[key] as number | undefined;
    const b = to[key] as number | undefined;
    if (a === undefined && b !== undefined) tightened = true;
    else if (a !== undefined && b === undefined) relaxed = true;
    else if (a !== undefined && b !== undefined && a !== b) (b > a ? (tightened = true) : (relaxed = true));
  }

  for (const key of upper) {
    const a = from[key] as number | undefined;
    const b = to[key] as number | undefined;
    if (a === undefined && b !== undefined) tightened = true;
    else if (a !== undefined && b === undefined) relaxed = true;
    else if (a !== undefined && b !== undefined && a !== b) (b < a ? (tightened = true) : (relaxed = true));
  }

  if (from.pattern !== to.pattern) {
    if (from.pattern === undefined) tightened = true;
    else if (to.pattern === undefined) relaxed = true;
    else tightened = true; // a different pattern may reject previously valid input
  }

  if (tightened) return "tightened";
  if (relaxed) return "relaxed";
  return null;
}

/**
 * Paths where exactly one side is a schema we could not read.
 *
 * `unknown` is what normalization gives a schema it found and could not type: a
 * union with no single type, a `$ref` nobody followed, an empty `{}`. It means
 * "we read nothing here", and a difference against nothing is not a change.
 * Compared naively, a parameter that was always an integer and was once spelled
 * as a union reports `changed type from unknown to integer`, breaking, and every
 * bound on it reports as newly tightened.
 *
 * Both sides `unknown` is left alone: nothing is claimed about the type, and
 * whatever sits beside it on the schema is compared like for like.
 */
function unreadOnOneSide(a: Map<string, Param>, b: Map<string, Param>): Set<string> {
  const out = new Set<string>();
  for (const [path, before] of a) {
    const after = b.get(path);
    if (after === undefined) continue;
    if ((before.type === "unknown") !== (after.type === "unknown")) out.add(path);
  }
  return out;
}

/** The path itself, or anything beneath it: a field of it, or its element. */
function isWithin(path: string, unread: ReadonlySet<string>): boolean {
  for (const root of unread) {
    if (path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[]`)) return true;
  }
  return false;
}

function diffParams(
  tool: string,
  from: Tool,
  to: Tool,
): { changes: StructuralChange[]; withheld: StructuralChange[] } {
  const changes: StructuralChange[] = [];
  const withheld: StructuralChange[] = [];
  const a = flatten(from.params);
  const b = flatten(to.params);
  const unread = unreadOnOneSide(a, b);

  // A field under a parameter we could not read on one side was never seen on
  // that side, so "added" and "removed" there describe our reading. Whether the
  // parameter itself became required is still a fact: that comes from the list
  // beside it, which was read on both sides.
  const sink = (path: string) => (isWithin(path, unread) ? withheld : changes);

  for (const [path, param] of b) {
    if (a.has(path) || isElement(path)) continue;
    const rule: StructuralRule = param.required ? "param_added_required" : "param_added_optional";
    sink(path).push({
      rule,
      target: `${tool}.${path}`,
      tool,
      breaking: CALLER_BREAKING.has(rule),
      to: param.type,
      note: param.required
        ? `required parameter \`${path}\` added`
        : `optional parameter \`${path}\` added${param.description === null ? " with no description" : ""}`,
    });
  }

  for (const [path, param] of a) {
    if (b.has(path) || isElement(path)) continue;
    sink(path).push({
      rule: "param_removed",
      target: `${tool}.${path}`,
      tool,
      breaking: true,
      from: param.type,
      note: `parameter \`${path}\` removed`,
    });
  }

  for (const [path, before] of a) {
    const after = b.get(path);
    if (!after) continue;

    if (before.type !== after.type) {
      sink(path).push({
        rule: "param_type_changed",
        target: `${tool}.${path}`,
        tool,
        breaking: true,
        from: before.type,
        to: after.type,
        note: `\`${path}\` changed type from ${before.type} to ${after.type}`,
      });
    }

    if (before.required !== after.required) {
      const rule: StructuralRule = after.required ? "param_became_required" : "param_became_optional";
      changes.push({
        rule,
        target: `${tool}.${path}`,
        tool,
        breaking: CALLER_BREAKING.has(rule),
        from: before.required,
        to: after.required,
        note: after.required
          ? `\`${path}\` is now required`
          : `\`${path}\` is no longer required`,
      });
    }

    const beforeEnum = enumOf(before.constraints);
    const afterEnum = enumOf(after.constraints);
    if (beforeEnum && afterEnum && beforeEnum.join("|") !== afterEnum.join("|")) {
      const removed = beforeEnum.filter((v) => !afterEnum.includes(v));
      const rule: StructuralRule = removed.length > 0 ? "enum_narrowed" : "enum_widened";
      sink(path).push({
        rule,
        target: `${tool}.${path}`,
        tool,
        breaking: CALLER_BREAKING.has(rule),
        from: beforeEnum,
        to: afterEnum,
        note:
          removed.length > 0
            ? `\`${path}\` no longer accepts ${removed.join(", ")}`
            : `\`${path}\` accepts additional values`,
      });
    }

    const bounds = boundsDelta(before.constraints, after.constraints);
    if (bounds) {
      const rule: StructuralRule = bounds === "tightened" ? "constraint_tightened" : "constraint_relaxed";
      sink(path).push({
        rule,
        target: `${tool}.${path}`,
        tool,
        breaking: CALLER_BREAKING.has(rule),
        from: before.constraints,
        to: after.constraints,
        note: `constraints on \`${path}\` were ${bounds}`,
      });
    }
  }

  return { changes, withheld };
}

export function diffStructural(from: Contract, to: Contract): StructuralDiff {
  const a = byName(from.tools);
  const b = byName(to.tools);
  const changes: StructuralChange[] = [];
  const withheld: StructuralChange[] = [];

  for (const name of b.keys()) {
    if (a.has(name)) continue;
    changes.push({
      rule: "tool_added",
      target: name,
      tool: name,
      breaking: false,
      note: `tool \`${name}\` added`,
    });
  }

  for (const name of a.keys()) {
    if (b.has(name)) continue;
    changes.push({
      rule: "tool_removed",
      target: name,
      tool: name,
      breaking: true,
      note: `tool \`${name}\` removed`,
    });
  }

  for (const [name, before] of a) {
    const after = b.get(name);
    if (!after) continue;
    const params = diffParams(name, before, after);
    changes.push(...params.changes);
    withheld.push(...params.withheld);
  }

  return {
    changes,
    breaking: changes.some((c) => c.breaking),
    changedTools: [...new Set(changes.map((c) => c.tool))].sort(),
    ...(withheld.length === 0 ? {} : { withheld }),
  };
}
