import ts from "typescript";

/**
 * Gets the CommonTools module alias used in AMD output.
 * In AMD output, TypeScript transforms module imports to parameters.
 * For imports from "commontools", it typically becomes "commontools_1".
 */
export function getCommonToolsModuleAlias(
  sourceFile: ts.SourceFile,
): string | null {
  // In AMD output, TypeScript transforms module imports to parameters
  // For imports from "commontools", it typically becomes "commontools_1"
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === "commontools"
      ) {
        // For named imports in AMD, TypeScript generates a module parameter
        // like "commontools_1". Since we're working at the AST level before
        // AMD transformation, we need to anticipate this pattern.
        // Return the expected AMD module alias
        return "commontools_1";
      }
    }
  }
  return null;
}

/**
 * Checks if a specific import exists from commontools.
 */
export function hasCommonToolsImport(
  sourceFile: ts.SourceFile,
  importName: string,
): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === "commontools"
      ) {
        // Check if the specific import is in the import clause
        if (statement.importClause && statement.importClause.namedBindings) {
          if (ts.isNamedImports(statement.importClause.namedBindings)) {
            for (
              const element of statement.importClause.namedBindings.elements
            ) {
              if (element.name.text === importName) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Adds an import to the commontools module.
 */
export function addCommonToolsImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  importName: string,
): ts.SourceFile {
  let existingImport: ts.ImportDeclaration | undefined;
  let existingImportIndex: number = -1;
  let moduleSpecifierText: string = "";

  // Find existing commontools import
  sourceFile.statements.forEach((statement, index) => {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === "commontools"
      ) {
        existingImport = statement;
        existingImportIndex = index;
        moduleSpecifierText = moduleSpecifier.text;
      }
    }
  });

  let newImport: ts.ImportDeclaration;

  if (
    existingImport && existingImport.importClause &&
    existingImport.importClause.namedBindings &&
    ts.isNamedImports(existingImport.importClause.namedBindings)
  ) {
    // Add to existing import if not already present
    const existingElements = existingImport.importClause.namedBindings.elements;
    const hasImport = existingElements.some((element) =>
      element.name.text === importName
    );

    if (hasImport) {
      return sourceFile;
    }

    const newElements = [
      ...existingElements,
      factory.createImportSpecifier(
        false,
        undefined,
        factory.createIdentifier(importName),
      ),
    ];

    newImport = factory.updateImportDeclaration(
      existingImport,
      undefined,
      factory.createImportClause(
        false,
        existingImport.importClause.name,
        factory.createNamedImports(newElements),
      ),
      existingImport.moduleSpecifier,
      undefined,
    );
  } else {
    // Create new import declaration for commontools
    newImport = factory.createImportDeclaration(
      undefined,
      factory.createImportClause(
        false,
        undefined,
        factory.createNamedImports([
          factory.createImportSpecifier(
            false,
            undefined,
            factory.createIdentifier(importName),
          ),
        ]),
      ),
      factory.createStringLiteral("commontools"),
      undefined,
    );

    // Add as first statement or after existing imports
    const newStatements = [...sourceFile.statements];
    let insertIndex = 0;

    // Find the position after all import declarations
    for (let i = 0; i < newStatements.length; i++) {
      if (ts.isImportDeclaration(newStatements[i])) {
        insertIndex = i + 1;
      } else {
        break;
      }
    }

    newStatements.splice(insertIndex, 0, newImport);

    return factory.updateSourceFile(
      sourceFile,
      newStatements,
      sourceFile.isDeclarationFile,
      sourceFile.referencedFiles,
      sourceFile.typeReferenceDirectives,
      sourceFile.hasNoDefaultLib,
      sourceFile.libReferenceDirectives,
    );
  }

  // Reconstruct statements with the new import
  const newStatements = [...sourceFile.statements];
  newStatements[existingImportIndex] = newImport;

  return factory.updateSourceFile(
    sourceFile,
    newStatements,
    sourceFile.isDeclarationFile,
    sourceFile.referencedFiles,
    sourceFile.typeReferenceDirectives,
    sourceFile.hasNoDefaultLib,
    sourceFile.libReferenceDirectives,
  );
}

/**
 * Removes an import from the commontools module.
 */
export function removeCommonToolsImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  importName: string,
): ts.SourceFile {
  let existingImport: ts.ImportDeclaration | undefined;
  let existingImportIndex: number = -1;

  // Find existing commontools import
  sourceFile.statements.forEach((statement, index) => {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === "commontools"
      ) {
        existingImport = statement;
        existingImportIndex = index;
      }
    }
  });

  if (
    !existingImport || !existingImport.importClause ||
    !existingImport.importClause.namedBindings ||
    !ts.isNamedImports(existingImport.importClause.namedBindings)
  ) {
    return sourceFile;
  }

  const existingElements = existingImport.importClause.namedBindings.elements;
  const newElements = existingElements.filter(
    (element) => element.name.text !== importName,
  );

  // If no imports left, remove the entire import statement
  if (newElements.length === 0) {
    const newStatements = sourceFile.statements.filter(
      (_, index) => index !== existingImportIndex,
    );
    return factory.updateSourceFile(
      sourceFile,
      newStatements,
      sourceFile.isDeclarationFile,
      sourceFile.referencedFiles,
      sourceFile.typeReferenceDirectives,
      sourceFile.hasNoDefaultLib,
      sourceFile.libReferenceDirectives,
    );
  }

  // Otherwise, update the import with remaining imports
  const newImport = factory.updateImportDeclaration(
    existingImport,
    undefined,
    factory.createImportClause(
      false,
      existingImport.importClause.name,
      factory.createNamedImports(newElements),
    ),
    existingImport.moduleSpecifier,
    undefined,
  );

  const newStatements = [...sourceFile.statements];
  newStatements[existingImportIndex] = newImport;

  return factory.updateSourceFile(
    sourceFile,
    newStatements,
    sourceFile.isDeclarationFile,
    sourceFile.referencedFiles,
    sourceFile.typeReferenceDirectives,
    sourceFile.hasNoDefaultLib,
    sourceFile.libReferenceDirectives,
  );
}
