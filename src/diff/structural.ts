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
};

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.name, i]));
}

/** Flatten nested params to dotted paths so a change three levels down is still visible. */
function flatten(params: Param[], prefix = ""): Map<string, Param> {
  const out = new Map<string, Param>();
  for (const p of params) {
    const path = prefix ? `${prefix}.${p.name}` : p.name;
    out.set(path, p);
    if (p.children?.length) {
      for (const [k, v] of flatten(p.children, path)) out.set(k, v);
    }
  }
  return out;
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

function diffParams(tool: string, from: Tool, to: Tool): StructuralChange[] {
  const changes: StructuralChange[] = [];
  const a = flatten(from.params);
  const b = flatten(to.params);

  for (const [path, param] of b) {
    if (a.has(path)) continue;
    const rule: StructuralRule = param.required ? "param_added_required" : "param_added_optional";
    changes.push({
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
    if (b.has(path)) continue;
    changes.push({
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
      changes.push({
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
      changes.push({
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
      changes.push({
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

  return changes;
}

export function diffStructural(from: Contract, to: Contract): StructuralDiff {
  const a = byName(from.tools);
  const b = byName(to.tools);
  const changes: StructuralChange[] = [];

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
    if (after) changes.push(...diffParams(name, before, after));
  }

  return {
    changes,
    breaking: changes.some((c) => c.breaking),
    changedTools: [...new Set(changes.map((c) => c.tool))].sort(),
  };
}
