import ts from "typescript";

export function getCommonToolsModuleAlias(
  sourceFile: ts.SourceFile,
): string | null {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === "commontools"
      ) {
        const clause = statement.importClause;
        if (clause?.namedBindings &&
          ts.isNamespaceImport(clause.namedBindings)
        ) {
          return clause.namedBindings.name.text;
        }
        if (clause?.name) {
          return clause.name.text;
        }
      }
    }
  }
  return null;
}

export function getCommonToolsImportIdentifier(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  importName: string,
): ts.Identifier | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "commontools") continue;

    const clause = statement.importClause;
    if (!clause || !clause.namedBindings) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;

    for (const element of clause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName !== importName) continue;

      const identifier = factory.createIdentifier(element.name.text);
      ts.setOriginalNode(identifier, element.name);
      ts.setTextRange(identifier, { pos: element.name.pos, end: element.name.end });
      const sourceMapRange = ts.getSourceMapRange(element.name);
      if (sourceMapRange) {
        ts.setSourceMapRange(identifier, sourceMapRange);
      }
      return identifier;
    }
  }

  return null;
}

export function hasCommonToolsImport(
  sourceFile: ts.SourceFile,
  importName: string,
): boolean {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "commontools") continue;

    const clause = statement.importClause;
    if (!clause || !clause.namedBindings) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;

    for (const element of clause.namedBindings.elements) {
      if (element.name.text === importName) {
        return true;
      }
    }
  }
  return false;
}

export function addCommonToolsImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  importName: string,
): ts.SourceFile {
  let existingImport: ts.ImportDeclaration | undefined;
  let existingIndex = -1;

  sourceFile.statements.forEach((statement, index) => {
    if (!ts.isImportDeclaration(statement)) return;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
    if (statement.moduleSpecifier.text !== "commontools") return;
    existingImport = statement;
    existingIndex = index;
  });

  if (
    existingImport &&
    existingImport.importClause &&
    existingImport.importClause.namedBindings &&
    ts.isNamedImports(existingImport.importClause.namedBindings)
  ) {
    const existingElements = existingImport.importClause.namedBindings.elements;
    const alreadyPresent = existingElements.some((element) =>
      element.name.text === importName
    );
    if (alreadyPresent) {
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

    const newImport = factory.updateImportDeclaration(
      existingImport,
      existingImport.modifiers,
      factory.createImportClause(
        false,
        existingImport.importClause.name,
        factory.createNamedImports(newElements),
      ),
      existingImport.moduleSpecifier,
      existingImport.assertClause,
    );

    const statements = [...sourceFile.statements];
    statements[existingIndex] = newImport;
    return factory.updateSourceFile(
      sourceFile,
      statements,
      sourceFile.isDeclarationFile,
      sourceFile.referencedFiles,
      sourceFile.typeReferenceDirectives,
      sourceFile.hasNoDefaultLib,
      sourceFile.libReferenceDirectives,
    );
  }

  const newImport = factory.createImportDeclaration(
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

  const statements = [...sourceFile.statements];
  let insertIndex = 0;
  for (const statement of statements) {
    if (ts.isImportDeclaration(statement)) {
      insertIndex += 1;
    } else {
      break;
    }
  }
  statements.splice(insertIndex, 0, newImport);

  return factory.updateSourceFile(
    sourceFile,
    statements,
    sourceFile.isDeclarationFile,
    sourceFile.referencedFiles,
    sourceFile.typeReferenceDirectives,
    sourceFile.hasNoDefaultLib,
    sourceFile.libReferenceDirectives,
  );
}

export function removeCommonToolsImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  importName: string,
): ts.SourceFile {
  let existingImport: ts.ImportDeclaration | undefined;
  let existingIndex = -1;

  sourceFile.statements.forEach((statement, index) => {
    if (!ts.isImportDeclaration(statement)) return;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
    if (statement.moduleSpecifier.text !== "commontools") return;
    existingImport = statement;
    existingIndex = index;
  });

  if (
    !existingImport ||
    !existingImport.importClause ||
    !existingImport.importClause.namedBindings ||
    !ts.isNamedImports(existingImport.importClause.namedBindings)
  ) {
    return sourceFile;
  }

  const existingElements = existingImport.importClause.namedBindings.elements;
  const remaining = existingElements.filter((element) =>
    element.name.text !== importName
  );

  if (remaining.length === 0) {
    const statements = sourceFile.statements.filter((_, index) =>
      index !== existingIndex
    );
    return factory.updateSourceFile(
      sourceFile,
      statements,
      sourceFile.isDeclarationFile,
      sourceFile.referencedFiles,
      sourceFile.typeReferenceDirectives,
      sourceFile.hasNoDefaultLib,
      sourceFile.libReferenceDirectives,
    );
  }

  const newImport = factory.updateImportDeclaration(
    existingImport,
    existingImport.modifiers,
    factory.createImportClause(
      false,
      existingImport.importClause.name,
      factory.createNamedImports(remaining),
    ),
    existingImport.moduleSpecifier,
    existingImport.assertClause,
  );

  const statements = [...sourceFile.statements];
  statements[existingIndex] = newImport;

  return factory.updateSourceFile(
    sourceFile,
    statements,
    sourceFile.isDeclarationFile,
    sourceFile.referencedFiles,
    sourceFile.typeReferenceDirectives,
    sourceFile.hasNoDefaultLib,
    sourceFile.libReferenceDirectives,
  );
}
