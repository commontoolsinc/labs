import ts from "typescript";
import { Program, ProgramResolver, Source } from "../interface.ts";

export type UnresolvedModuleHandling =
  | { type: "allow"; identifiers: string[] }
  | { type: "allow-all" }
  | { type: "deny" };

export interface ResolveModuleConfig {
  unresolvedModules: UnresolvedModuleHandling;
  resolveUnresolvedModuleTypes: boolean;
  target: ts.ScriptTarget;
}

export async function resolveProgram(
  graph: ProgramResolver,
  { unresolvedModules, target, resolveUnresolvedModuleTypes }:
    ResolveModuleConfig,
): Promise<Program> {
  const main = await graph.main();
  const sources = new Map([[main.name, main]]);
  const toProcess = [main.name];
  const processed: string[] = [];

  while (toProcess.length > 0) {
    const currentName = toProcess.shift()!;
    if (processed.includes(currentName)) {
      continue;
    }
    const current = sources.get(currentName)!;
    const specifiers = getImports(current, target);
    for (const specifier of specifiers) {
      const identifier = resolveSpecifier(specifier, current);
      if (sources.has(identifier)) {
        continue;
      }
      const newSource = await graph.resolveSource(identifier);
      if (!newSource) {
        isUnresolvedModuleOk(identifier, unresolvedModules);
        if (resolveUnresolvedModuleTypes) {
          const typeDefIdentifier = `${identifier}.d.ts`;
          if (!sources.has(typeDefIdentifier)) {
            const typeDef = await graph.resolveSource(typeDefIdentifier);
            if (typeDef) {
              sources.set(typeDefIdentifier, typeDef);
              toProcess.push(typeDefIdentifier);
            }
          }
        }
        continue;
      }
      sources.set(identifier, newSource as Source);
      toProcess.push(identifier);
    }
  }

  return {
    main: main.name,
    files: [...sources.values()],
  };
}

function isUnresolvedModuleOk(
  identifier: string,
  config: UnresolvedModuleHandling,
) {
  switch (config.type) {
    case "allow-all":
      return;
    case "allow": {
      if (config.identifiers.includes(identifier)) {
        return;
      }
    }
    /* falls through */
    case "deny":
    default:
      throw new Error(
        `Could not resolve "${identifier}".`,
      );
  }
}

// Moved to `../specifier.ts` (typescript-free) so runtime consumers can use it
// without pulling the compiler into their bundle; re-exported here for the
// existing compile-path importers.
export { resolveImportSpecifier } from "../specifier.ts";
import { resolveImportSpecifier as resolveSpecifier } from "../specifier.ts";

/**
 * Collect every import/`export … from` specifier referenced by a source file,
 * including type-only imports (`import type`, type-only named specifiers) and
 * inline import-type references (`import("./mod").Foo`). Type edges are
 * intentionally retained: in Common Fabric the transformer lowers types into
 * generated schemas, so a changed imported type can change runtime behavior.
 * Dynamic `import()` *expressions* and `require()` are not supported and are
 * ignored.
 *
 * This is a superset of {@link resolveProgram}'s graph discovery: it adds
 * inline import-type edges so module identity does not miss schema-bearing type
 * dependencies. It deliberately does not influence which sources are fetched
 * for compilation.
 */
export function collectImportSpecifiers(
  source: Source,
  target: ts.ScriptTarget,
): string[] {
  return getImports(source, target, { includeImportTypeNodes: true });
}

function getImports(
  source: Source,
  target: ts.ScriptTarget,
  options: { includeImportTypeNodes?: boolean } = {},
): string[] {
  const sourceFile = ts.createSourceFile(
    source.name,
    source.contents,
    target,
    true,
  );

  const imports: string[] = [];

  function visit(node: ts.Node) {
    // Handle import declarations: import { foo } from 'module'
    // We intentionally skip dynamic imports and require statements. Unsupported.
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        imports.push(moduleSpecifier.text);
      }
    }
    // `export * from "specifier";`
    if (ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        imports.push(moduleSpecifier.text);
      }
    }
    // Inline import-type references in type position: `import("./mod").Foo`.
    // These are load-bearing for schema generation but are not module-graph
    // edges for resolution, so only the identity collector opts in.
    if (options.includeImportTypeNodes && ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
      ) {
        imports.push(argument.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...new Set(imports)];
}
