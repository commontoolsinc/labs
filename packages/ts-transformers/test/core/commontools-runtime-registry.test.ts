import ts from "typescript";
import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";

import { COMMONTOOLS_RUNTIME_EXPORTS_BY_NAME } from "../../src/core/commontools-runtime-registry.ts";

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

function extractInjectedCallableExports(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    FACTORY_URL.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const importedIdentifiers = new Map<string, string>();
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

  let commontoolsObject: ts.ObjectLiteralExpression | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      getPropertyNameText(node.name) === "commontools" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      commontoolsObject = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  });

  assert(
    commontoolsObject,
    "Failed to locate createBuilder().commontools object in runner builder factory",
  );

  const injectedExports = new Set<string>();
  for (const property of commontoolsObject.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      const importSource = importedIdentifiers.get(property.name.text);
      if (TRACKED_IMPORT_SOURCES.has(importSource ?? "")) {
        injectedExports.add(property.name.text);
      }
      continue;
    }

    if (!ts.isPropertyAssignment(property)) continue;

    const exportName = getPropertyNameText(property.name);
    if (!exportName || !ts.isIdentifier(property.initializer)) continue;

    const importSource = importedIdentifiers.get(property.initializer.text);
    if (TRACKED_IMPORT_SOURCES.has(importSource ?? "")) {
      injectedExports.add(exportName);
    }
  }

  return [...injectedExports].sort();
}

describe("COMMONTOOLS_RUNTIME_EXPORT_REGISTRY", () => {
  it("covers every imported callable injected by runner builder factory", async () => {
    const factorySource = await Deno.readTextFile(FACTORY_URL);
    const injectedExports = extractInjectedCallableExports(factorySource);
    const missing = injectedExports.filter((name) =>
      !COMMONTOOLS_RUNTIME_EXPORTS_BY_NAME.has(name)
    );

    assertEquals(
      missing,
      [],
      [
        "builder/factory.ts injects callable exports that are missing from COMMONTOOLS_RUNTIME_EXPORT_REGISTRY.",
        `Missing exports: ${missing.join(", ") || "(none)"}`,
        "Add each export to src/core/commontools-runtime-registry.ts and explicitly decide whether reactiveOrigin should be true or false.",
        "If the export needs dedicated detection behavior, also update src/ast/call-kind.ts to map it to the right CallKind.",
      ].join("\n"),
    );
  });
});
