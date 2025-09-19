import ts from "typescript";

export interface ImportSpec {
  readonly module: string;
  readonly typeOnly: boolean;
}

export interface ImportRequest extends Partial<ImportSpec> {
  readonly name: string;
}

interface ImportRecord extends ImportSpec {
  readonly names: Set<string>;
}

export interface ImportManager {
  request(request: ImportRequest): void;
  has(request: ImportRequest): boolean;
  entries(): Iterable<ImportRecord>;
  clear(): void;
}

const DEFAULT_MODULE = "commontools";

class SimpleImportManager implements ImportManager {
  #records = new Map<string, ImportRecord>();

  request(request: ImportRequest): void {
    const module = request.module ?? DEFAULT_MODULE;
    const key = `${module}|${request.typeOnly ? "t" : "v"}`;
    const existing = this.#records.get(key);
    if (existing) {
      existing.names.add(request.name);
      return;
    }
    this.#records.set(key, {
      module,
      typeOnly: request.typeOnly ?? false,
      names: new Set([request.name]),
    });
  }

  has(request: ImportRequest): boolean {
    const module = request.module ?? DEFAULT_MODULE;
    const key = `${module}|${request.typeOnly ? "t" : "v"}`;
    const existing = this.#records.get(key);
    return existing ? existing.names.has(request.name) : false;
  }

  *entries(): Iterable<ImportRecord> {
    for (const record of this.#records.values()) {
      yield record;
    }
  }

  clear(): void {
    this.#records.clear();
  }
}

export function createImportManager(): ImportManager {
  return new SimpleImportManager();
}

function ensureImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  record: ImportRecord,
): ts.SourceFile {
  let existing: ts.ImportDeclaration | undefined;
  let existingIndex = -1;

  sourceFile.statements.forEach((statement, index) => {
    if (!ts.isImportDeclaration(statement)) {
      return;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      return;
    }
    if (statement.moduleSpecifier.text !== record.module) {
      return;
    }
    const clause = statement.importClause;
    if (!clause || !clause.namedBindings) {
      return;
    }
    if (!ts.isNamedImports(clause.namedBindings)) {
      return;
    }
    if (record.typeOnly && !clause.isTypeOnly) {
      return;
    }
    existing = statement;
    existingIndex = index;
  });

  if (existing) {
    return updateImport(existing, existingIndex, sourceFile, factory, record);
  }
  return insertImport(sourceFile, factory, record);
}

function updateImport(
  existing: ts.ImportDeclaration,
  index: number,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  record: ImportRecord,
): ts.SourceFile {
  const clause = existing.importClause;
  if (!clause || !clause.namedBindings) {
    return sourceFile;
  }

  const named = clause.namedBindings;
  if (!ts.isNamedImports(named)) {
    return sourceFile;
  }

  const existingNames = new Set(
    named.elements.map((element) => element.name.text),
  );
  const nextElements = [...named.elements];

  for (const name of record.names) {
    if (existingNames.has(name)) continue;
    nextElements.push(
      factory.createImportSpecifier(
        false,
        undefined,
        factory.createIdentifier(name),
      ),
    );
  }

  if (nextElements.length === named.elements.length) {
    return sourceFile;
  }

  const updated = factory.updateImportDeclaration(
    existing,
    existing.modifiers,
    factory.updateImportClause(
      clause,
      record.typeOnly || clause.isTypeOnly,
      clause.name,
      factory.createNamedImports(nextElements),
    ),
    existing.moduleSpecifier,
    existing.assertClause,
  );

  const statements = [...sourceFile.statements];
  statements[index] = updated;
  return factory.updateSourceFile(sourceFile, statements);
}

function insertImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  record: ImportRecord,
): ts.SourceFile {
  const elements = Array.from(record.names).map((name) =>
    factory.createImportSpecifier(
      false,
      undefined,
      factory.createIdentifier(name),
    )
  );

  const clause = factory.createImportClause(
    record.typeOnly,
    undefined,
    factory.createNamedImports(elements),
  );

  const declaration = factory.createImportDeclaration(
    undefined,
    clause,
    factory.createStringLiteral(record.module),
    undefined,
  );

  const statements = [...sourceFile.statements];
  let insertIndex = 0;
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (!statement) {
      break;
    }
    if (ts.isImportDeclaration(statement)) {
      insertIndex = i + 1;
      continue;
    }
    break;
  }
  statements.splice(insertIndex, 0, declaration);
  return factory.updateSourceFile(sourceFile, statements);
}

export function applyPendingImports(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  manager: ImportManager,
): ts.SourceFile {
  let updated = sourceFile;
  for (const record of manager.entries()) {
    updated = ensureImport(updated, factory, record);
  }
  manager.clear();
  return updated;
}
