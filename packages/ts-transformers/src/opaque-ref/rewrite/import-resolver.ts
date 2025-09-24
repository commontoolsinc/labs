import ts from "typescript";

/**
 * Finds an existing import identifier for a given name from a module
 */
export function findImportedIdentifier(
  sourceFile: ts.SourceFile,
  importName: string,
  moduleName: string = "commontools",
): ts.Identifier | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === moduleName
      ) {
        const namedBindings = statement.importClause?.namedBindings;
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            const name = element.propertyName?.text || element.name.text;
            if (name === importName) {
              return element.name; // This is the local identifier
            }
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Gets or creates an identifier for a commontools helper function
 */
export function getHelperIdentifier(
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  helperName: string,
): ts.Identifier {
  // First try to find if it's already imported
  const existing = findImportedIdentifier(sourceFile, helperName);
  if (existing) {
    // Return the existing identifier (reuse the same node)
    return existing;
  }

  // If not imported, create a bare identifier
  // (The import manager will handle adding the import)
  return factory.createIdentifier(helperName);
}
