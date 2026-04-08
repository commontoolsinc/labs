import ts from "typescript";
import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";

import { COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME } from "../../src/core/commonfabric-runtime-registry.ts";

const FACTORY_URL = new URL(
  "../../../runner/src/builder/factory.ts",
  import.meta.url,
);

const TRACKED_IMPORT_SOURCES = new Set([
  "./built-in.ts",
  "./module.ts",
  "./pattern.ts",
]);

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function extractInjectedCallableExports(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    FACTORY_URL.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const importedIdentifiers = new Map<string, string>();
  const localBindings = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    const importSource = statement.moduleSpecifier.text;
    for (const specifier of statement.importClause.namedBindings.elements) {
      importedIdentifiers.set(specifier.name.text, importSource);
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer
      ) {
        localBindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  let commonfabricObject: ts.ObjectLiteralExpression | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "commonfabric" &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        commonfabricObject = initializer;
        return;
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      getPropertyNameText(node.name) === "commonfabric"
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        commonfabricObject = initializer;
        return;
      }
      return;
    }
    ts.forEachChild(node, visit);
  });

  assert(
    commonfabricObject,
    "Failed to locate createBuilder().commonfabric object in runner builder factory",
  );

  const injectedExports = new Set<string>();
  for (const property of commonfabricObject.properties) {
    const exportName = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isPropertyAssignment(property)
      ? getPropertyNameText(property.name)
      : undefined;
    const valueIdentifier = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.initializer)
      ? property.initializer.text
      : undefined;
    if (!exportName || !valueIdentifier) continue;

    for (
      const importSource of collectReferencedImportSources(
        valueIdentifier,
        importedIdentifiers,
        localBindings,
      )
    ) {
      if (TRACKED_IMPORT_SOURCES.has(importSource)) {
        injectedExports.add(exportName);
        break;
      }
    }
  }

  return [...injectedExports].sort();
}

function collectReferencedImportSources(
  identifier: string,
  importedIdentifiers: ReadonlyMap<string, string>,
  localBindings: ReadonlyMap<string, ts.Expression>,
  visiting = new Set<string>(),
): Set<string> {
  const directImportSource = importedIdentifiers.get(identifier);
  if (directImportSource) {
    return new Set([directImportSource]);
  }

  if (visiting.has(identifier)) {
    return new Set();
  }

  const initializer = localBindings.get(identifier);
  if (!initializer) {
    return new Set();
  }

  visiting.add(identifier);
  const referencedSources = new Set<string>();
  ts.forEachChild(initializer, function visit(node) {
    if (ts.isIdentifier(node)) {
      for (
        const source of collectReferencedImportSources(
          node.text,
          importedIdentifiers,
          localBindings,
          visiting,
        )
      ) {
        referencedSources.add(source);
      }
      return;
    }
    ts.forEachChild(node, visit);
  });
  visiting.delete(identifier);
  return referencedSources;
}

describe("COMMONFABRIC_RUNTIME_EXPORT_REGISTRY", () => {
  it("covers every imported callable injected by runner builder factory", async () => {
    const factorySource = await Deno.readTextFile(FACTORY_URL);
    const injectedExports = extractInjectedCallableExports(factorySource);
    const missing = injectedExports.filter((name) =>
      !COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME.has(name)
    );

    assertEquals(
      missing,
      [],
      [
        "builder/factory.ts injects callable exports that are missing from COMMONFABRIC_RUNTIME_EXPORT_REGISTRY.",
        `Missing exports: ${missing.join(", ") || "(none)"}`,
        "Add each export to src/core/commonfabric-runtime-registry.ts and explicitly decide whether reactiveOrigin should be true or false.",
        "If the export needs dedicated detection behavior, also update src/ast/call-kind.ts to map it to the right CallKind.",
      ].join("\n"),
    );
  });
});
