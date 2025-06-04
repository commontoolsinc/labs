import ts from "typescript";
import { Program, ProgramResolver, Source } from "../interface.ts";
import { dirname, join } from "@std/path";

export type UnresolvedModuleHandling =
  | { type: "allow"; specifiers: string[] }
  | { type: "allow-all" }
  | { type: "deny" };

export interface ResolveModuleConfig {
  unresolvedModules: UnresolvedModuleHandling;
  resolveUnresolvedModuleTypes: boolean;
  target: ts.ScriptTarget;
}

export function resolveProgram(
  graph: ProgramResolver,
  { unresolvedModules, target, resolveUnresolvedModuleTypes }:
    ResolveModuleConfig,
): Program {
  const entry = graph.entry();
  const sources = new Map([[entry.name, entry]]);
  const toProcess = [entry.name];
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
      const newSource = graph.resolveSource(identifier);
      if (!newSource) {
        const { type } = unresolvedModules;
        if (
          type === "allow-all" ||
          (type === "allow" && unresolvedModules.specifiers.includes(specifier))
        ) {
          if (resolveUnresolvedModuleTypes) {
            const typeDefIdentifier = `${identifier}.d.ts`;
            if (!sources.has(typeDefIdentifier)) {
              const typeDef = graph.resolveSource(typeDefIdentifier);
              if (typeDef) sources.set(typeDefIdentifier, typeDef);
            }
          }
          continue;
        } else {
          throw new Error(
            `Could not resolve "${specifier}" from "${current.name}".`,
          );
        }
      }
      sources.set(identifier, newSource as Source);
      toProcess.push(identifier);
    }
  }

  return {
    entry: entry.name,
    files: [...sources.values()],
  };
}

function resolveSpecifier(specifier: string, from: Source): string {
  if (specifier[0] === "." || specifier[1] === "/") {
    return join(dirname(from.name), specifier);
  }
  return specifier;
}

function getImports(
  source: Source,
  target: ts.ScriptTarget,
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
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...new Set(imports)];
}
