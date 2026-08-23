import { parse } from "acorn";
import type { AnyNode, Expression, Program } from "acorn";
import { UNRESOLVED, evaluate, isUnresolved, type BindingResolver } from "./js-literal.js";
import { resolveSpecifier, type EntryPointQuery, type PackageSource } from "./package-source.js";

/**
 * Constant resolution across a package's own files.
 *
 * Tool names are almost never string literals in shipped code. They come from a
 * shared constants module, often in a sibling package, so a reader that stops at
 * the file it was pointed at reports a surface whose tools it cannot name.
 *
 * This follows those constants — by parsing, never by importing. No module in
 * the graph is executed, and following stops at a fixed depth.
 */

export type ParsedModule = {
  program: Program;
  source: PackageSource;
  path: string;
};

/** How far to chase a constant through re-exports before giving up. */
const DEFAULT_MAX_DEPTH = 6;

type ImportBinding = {
  specifier: string;
  /** The name in the target module, or "default". A namespace import is not followed. */
  imported: string | null;
};

type ModuleFacts = {
  /** Module-level bindings, by local name. */
  locals: Map<string, Expression>;
  imports: Map<string, ImportBinding>;
  /** `import * as ns` targets, by local name. Node lookup only, never folded. */
  namespaces: Map<string, string>;
  /** Exported name -> local name in this module. */
  exportsLocal: Map<string, string>;
  /** Exported name -> where it is re-exported from. */
  exportsFrom: Map<string, ImportBinding>;
  /** Specifiers this module re-exports from. A barrel file is still the surface. */
  reexports: string[];
  /** Relative specifiers this module imports. Same package, so the same door. */
  relativeImports: string[];
  /** `export * from` targets. A name not defined here may still be exported by one. */
  exportStars: string[];
};

export function parseModule(code: string, source: PackageSource, path: string): ParsedModule | null {
  // A pack is usually ESM, but plenty of published dist output is CommonJS.
  for (const sourceType of ["module", "script"] as const) {
    try {
      const program = parse(code, {
        ecmaVersion: "latest",
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        // Every claim has to carry a line a reader can check. `file.js:300` is
        // the evidence format the verdict artifact quotes.
        locations: true,
      });
      return { program, source, path };
    } catch {
      continue;
    }
  }
  return null;
}

function declaratorsOf(node: AnyNode, facts: ModuleFacts): void {
  if (node.type !== "VariableDeclaration") return;
  for (const declarator of node.declarations) {
    // Destructuring is not followed: the value it destructures is a call in
    // every real case, and a half-read binding is worse than none.
    if (declarator.id.type !== "Identifier" || !declarator.init) continue;
    facts.locals.set(declarator.id.name, declarator.init);
  }
}

function specifierName(node: { type: string; name?: string; value?: unknown }): string | null {
  if (node.type === "Identifier") return node.name ?? null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function factsOf(module: ParsedModule): ModuleFacts {
  const facts: ModuleFacts = {
    locals: new Map(),
    imports: new Map(),
    namespaces: new Map(),
    exportsLocal: new Map(),
    exportsFrom: new Map(),
    reexports: [],
    relativeImports: [],
    exportStars: [],
  };

  for (const statement of module.program.body) {
    switch (statement.type) {
      case "VariableDeclaration":
        declaratorsOf(statement, facts);
        break;

      // A function declaration is a binding like any other. It matters because
      // packages routinely wrap a schema type once and reuse it —
      // `function lenientString() { return z.string().min(1); }` — and a
      // resolver that only knows `const` cannot follow the wrapper. Its value
      // is never folded (a function has none); the zod reader reads what it
      // returns, which is a declaration sitting in plain sight.
      case "FunctionDeclaration":
        if (statement.id?.type === "Identifier") {
          facts.locals.set(statement.id.name, statement as unknown as Expression);
        }
        break;

      case "ImportDeclaration": {
        const specifier = statement.source.value;
        if (typeof specifier !== "string") break;
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          facts.relativeImports.push(specifier);
        }
        for (const entry of statement.specifiers) {
          if (entry.type === "ImportSpecifier") {
            const imported = specifierName(entry.imported);
            if (imported !== null) facts.imports.set(entry.local.name, { specifier, imported });
          } else if (entry.type === "ImportDefaultSpecifier") {
            facts.imports.set(entry.local.name, { specifier, imported: "default" });
          }
          else if (entry.type === "ImportNamespaceSpecifier") {
            // Recorded for *node* lookup only. Folding `ns` to a value would
            // mean modelling a whole module, which is why it stays out of
            // `imports` — but `ns.X` names one export, and that is a node the
            // graph can already find.
            facts.namespaces.set(entry.local.name, specifier);
          }
        }
        break;
      }

      case "ExportNamedDeclaration": {
        if (statement.declaration) {
          declaratorsOf(statement.declaration as AnyNode, facts);
          if (statement.declaration.type === "VariableDeclaration") {
            for (const declarator of statement.declaration.declarations) {
              if (declarator.id.type === "Identifier") {
                facts.exportsLocal.set(declarator.id.name, declarator.id.name);
              }
            }
          }
        }
        const from = statement.source?.value;
        if (typeof from === "string") facts.reexports.push(from);
        for (const entry of statement.specifiers) {
          const exported = specifierName(entry.exported);
          const local = specifierName(entry.local);
          if (exported === null || local === null) continue;
          if (typeof from === "string") facts.exportsFrom.set(exported, { specifier: from, imported: local });
          else facts.exportsLocal.set(exported, local);
        }
        break;
      }

      case "ExportAllDeclaration": {
        const source = statement.source.value;
        if (typeof source !== "string") break;
        facts.reexports.push(source);
        // `export * as ns from` binds a namespace object, not the names inside
        // it, so it is not a place a bare constant can be found.
        if (!statement.exported) facts.exportStars.push(source);
        break;
      }

      case "ExportDefaultDeclaration": {
        const declaration = statement.declaration;
        if (declaration.type !== "FunctionDeclaration" && declaration.type !== "ClassDeclaration") {
          facts.locals.set("*default*", declaration as Expression);
          facts.exportsLocal.set("default", "*default*");
        }
        break;
      }

      default:
        break;
    }
  }

  return facts;
}

/**
 * A parsed, fact-extracted view of every module reached so far.
 *
 * Cached per extraction run: a constants module gets imported by every file in a
 * pack, and re-parsing it each time is the difference between a fast backfill
 * and a slow one.
 */
export class ModuleGraph {
  private readonly parsed = new WeakMap<PackageSource, Map<string, ParsedModule | null>>();
  private readonly facts = new WeakMap<Program, ModuleFacts>();

  constructor(private readonly query: EntryPointQuery = {}) {}

  load(source: PackageSource, path: string): ParsedModule | null {
    let bySource = this.parsed.get(source);
    if (!bySource) {
      bySource = new Map();
      this.parsed.set(source, bySource);
    }
    const cached = bySource.get(path);
    if (cached !== undefined) return cached;

    const code = source.readFile(path);
    const module = code === null ? null : parseModule(code, source, path);
    bySource.set(path, module);
    return module;
  }

  factsFor(module: ParsedModule): ModuleFacts {
    let cached = this.facts.get(module.program);
    if (!cached) {
      cached = factsOf(module);
      this.facts.set(module.program, cached);
    }
    return cached;
  }

  /** Follow an import to the module it names, or null when it is not reachable. */
  private follow(module: ParsedModule, specifier: string): ParsedModule | null {
    const target = resolveSpecifier(specifier, module.path, module.source, this.query);
    return target === null ? null : this.load(target.source, target.path);
  }

  /**
   * The entry point, plus the modules that make up the same door.
   *
   * A published entry point is rarely where the descriptors live. It is either a
   * barrel that re-exports them, or a thin format shim that imports the pack and
   * adapts it. Both are the same door one hop further in.
   *
   * Two kinds of hop are followed, and the difference matters:
   *
   * - **Re-exports, anywhere, including into another package.** A re-export is a
   *   promise that what this module exports is what that one exports, so the
   *   consumer receives those bindings directly. Packages really do move a pack
   *   out of a sibling package and into themselves between releases; a walk that
   *   stopped at the package boundary would read that as every tool vanishing.
   * - **Relative imports, inside the package.** This is the shim-over-pack shape.
   *
   * A plain import of *another* package is not followed. That is a dependency
   * this module uses, not a door it hands over, and pulling its descriptors in
   * would merge two surfaces — destroying the very divergence this project
   * exists to detect.
   */
  surfaceModules(entry: ParsedModule, maxDepth = 5): ParsedModule[] {
    const collected: ParsedModule[] = [];
    // `load` memoizes, so the same file is always the same object; identity is
    // enough to stop a re-export cycle.
    const seen = new Set<ParsedModule>();
    const queue: Array<{ module: ParsedModule; depth: number }> = [{ module: entry, depth: 0 }];

    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      if (seen.has(next.module)) continue;
      seen.add(next.module);
      collected.push(next.module);
      if (next.depth >= maxDepth) continue;

      const facts = this.factsFor(next.module);
      // `relativeImports` is already filtered to same-package specifiers.
      for (const specifier of [...facts.reexports, ...facts.relativeImports]) {
        const target = this.follow(next.module, specifier);
        if (target !== null) queue.push({ module: target, depth: next.depth + 1 });
      }
    }

    return collected;
  }

  /** The value a module exports under `name`, folded as far as literals allow. */
  private exported(module: ParsedModule, name: string, depth: number, seen: Set<string>): unknown {
    if (depth <= 0) return UNRESOLVED;
    const facts = this.factsFor(module);

    const local = facts.exportsLocal.get(name);
    if (local !== undefined) return this.local(module, local, depth, seen);

    const from = facts.exportsFrom.get(name);
    if (from !== undefined && from.imported !== null) {
      const target = this.follow(module, from.specifier);
      return target === null ? UNRESOLVED : this.exported(target, from.imported, depth - 1, seen);
    }

    // Built output often exports a const without a matching specifier entry.
    if (facts.locals.has(name)) return this.local(module, name, depth, seen);

    // `export * from "./x.js"` — a barrel index is the normal shape for a
    // constants package, and the tool name is one file further in.
    const key = `star ${module.path} ${name}`;
    if (facts.exportStars.length === 0 || seen.has(key)) return UNRESOLVED;
    seen.add(key);
    try {
      for (const specifier of facts.exportStars) {
        const target = this.follow(module, specifier);
        if (target === null) continue;
        const value = this.exported(target, name, depth - 1, seen);
        if (!isUnresolved(value)) return value;
      }
    } finally {
      seen.delete(key);
    }
    return UNRESOLVED;
  }

  /** The value of a module-level binding, following imports where needed. */
  private local(module: ParsedModule, name: string, depth: number, seen: Set<string>): unknown {
    if (depth <= 0) return UNRESOLVED;

    const key = `${module.path} ${name}`;
    if (seen.has(key)) return UNRESOLVED; // a cycle; no value exists to read
    seen.add(key);

    try {
      const facts = this.factsFor(module);

      const init = facts.locals.get(name);
      if (init !== undefined) {
        return evaluate(init as AnyNode, (inner) => this.local(module, inner, depth - 1, seen)).value;
      }

      const imported = facts.imports.get(name);
      if (imported !== undefined && imported.imported !== null) {
        const target = this.follow(module, imported.specifier);
        return target === null ? UNRESOLVED : this.exported(target, imported.imported, depth - 1, seen);
      }

      return UNRESOLVED;
    } finally {
      seen.delete(key);
    }
  }

  /** A resolver for free identifiers appearing anywhere in `module`. */
  resolverFor(module: ParsedModule, maxDepth = DEFAULT_MAX_DEPTH): BindingResolver {
    return (name) => this.local(module, name, maxDepth, new Set());
  }

  /**
   * The AST node a binding was initialised with, and the module it lives in.
   *
   * `resolverFor` folds a binding to a *value*, which is the right answer for a
   * tool name and the wrong one for a schema built by calling functions. A zod
   * schema has no static value — `z.string()` is a call, and calling it is the
   * one thing this extractor must never do. Reading it means reading its shape,
   * and that needs the node.
   *
   * The module comes back with the node because a constant imported from
   * another file resolves its own identifiers there, not here.
   */
  nodeFor(
    module: ParsedModule,
    name: string,
    maxDepth = DEFAULT_MAX_DEPTH,
  ): { node: AnyNode; module: ParsedModule } | null {
    return this.nodeLookup(module, name, maxDepth, new Set());
  }

  private nodeLookup(
    module: ParsedModule,
    name: string,
    depth: number,
    seen: Set<string>,
  ): { node: AnyNode; module: ParsedModule } | null {
    if (depth <= 0) return null;

    const key = `node ${module.path} ${name}`;
    if (seen.has(key)) return null; // a cycle; there is no node to read
    seen.add(key);

    try {
      const facts = this.factsFor(module);

      // `ns.Name` from `import * as ns from "./x.js"`. One export of one
      // module, which is an ordinary lookup once the namespace is known.
      const dot = name.indexOf(".");
      if (dot > 0) {
        const head = name.slice(0, dot);
        const tail = name.slice(dot + 1);
        const specifier = facts.namespaces.get(head);
        if (specifier === undefined) return null;
        const target = this.follow(module, specifier);
        return target === null ? null : this.nodeLookup(target, tail, depth - 1, seen);
      }

      const init = facts.locals.get(name);
      if (init !== undefined) return { node: init as AnyNode, module };

      const imported = facts.imports.get(name);
      if (imported !== undefined && imported.imported !== null) {
        const target = this.follow(module, imported.specifier);
        return target === null
          ? null
          : this.nodeLookup(target, imported.imported, depth - 1, seen);
      }

      const local = facts.exportsLocal.get(name);
      if (local !== undefined && local !== name) {
        const found = this.nodeLookup(module, local, depth - 1, seen);
        if (found !== null) return found;
      }

      const exported = facts.exportsFrom.get(name);
      if (exported !== undefined && exported.imported !== null) {
        const target = this.follow(module, exported.specifier);
        return target === null
          ? null
          : this.nodeLookup(target, exported.imported, depth - 1, seen);
      }

      for (const specifier of facts.exportStars) {
        const target = this.follow(module, specifier);
        if (target === null) continue;
        const found = this.nodeLookup(target, name, depth - 1, seen);
        if (found !== null) return found;
      }

      return null;
    } finally {
      seen.delete(key);
    }
  }
}
