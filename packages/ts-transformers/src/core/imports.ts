import ts from "typescript";

export interface ImportRequest {
  readonly name: string;
  readonly module: string;
  readonly typeOnly?: boolean;
}

interface ModuleRequirements {
  readonly required: Set<string>;
  readonly forbidden: Set<string>;
  readonly module: string;
  readonly typeOnly: boolean;
}

// Accumulates requirements in the form of required
// or forbidden module imports. Once accumulated,
// these requirements can be applied to a SourceFile.
export class ImportRequirements {
  #map = new Map<string, ModuleRequirements>();

  // Marks the import as required, importing the
  // symbol during render if not already imported.
  require(request: ImportRequest): void {
    const reqs = this.#get(request);
    reqs.forbidden.delete(request.name);
    reqs.required.add(request.name);
  }

  // Marks the import for removal when rendered,
  // if imported by the source code.
  forbid(request: ImportRequest): void {
    const reqs = this.#get(request);
    reqs.required.delete(request.name);
    reqs.forbidden.add(request.name);
  }

  // Returns the requirements scoped by the request,
  // lazily creating and storing as needed.
  #get(request: ImportRequest): ModuleRequirements {
    const key = `${request.module}|${request.typeOnly ? "t" : "v"}`;
    const existing = this.#map.get(key);
    if (existing) {
      return existing;
    }
    const reqs = {
      module: request.module,
      typeOnly: request.typeOnly ?? false,
      required: new Set<string>(),
      forbidden: new Set<string>(),
    };
    this.#map.set(key, reqs);
    return reqs;
  }

  // Applies all requirements to the provided SourceFile,
  // returning the mapped source.
  apply(sourceFile: ts.SourceFile, factory: ts.NodeFactory): ts.SourceFile {
    let source = sourceFile;
    for (const record of this.#map.values()) {
      source = applyToSource(source, factory, record);
    }
    return source;
  }
}

function applyToSource(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  record: ModuleRequirements,
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
    const newStmt = applyToImport(existing, factory, record);
    if (newStmt) {
      const statements = [...sourceFile.statements];
      statements[existingIndex] = newStmt;
      return factory.updateSourceFile(sourceFile, statements);
    } else {
      return sourceFile;
    }
  }
  return insertImport(sourceFile, factory, record);
}

// Transforms the given import statement with
// the module requirements. Returns `undefined`
// if no transformation could be applied.
function applyToImport(
  existing: ts.ImportDeclaration,
  factory: ts.NodeFactory,
  record: ModuleRequirements,
): ts.ImportDeclaration | undefined {
  const clause = existing.importClause;
  if (!clause || !clause.namedBindings) {
    return undefined;
  }

  const named = clause.namedBindings;
  if (!ts.isNamedImports(named)) {
    return undefined;
  }

  const filteredExisting = named.elements.filter((element) =>
    !record.forbidden.has(element.name.text)
  );
  const didRemove = filteredExisting.length !== named.elements.length;
  const existingNames = new Set(
    filteredExisting.map((element) => element.name.text),
  );
  const nextElements = [...filteredExisting];

  for (const name of record.required) {
    if (existingNames.has(name)) continue;
    nextElements.push(
      factory.createImportSpecifier(
        false,
        undefined,
        factory.createIdentifier(name),
      ),
    );
  }

  if (!didRemove && nextElements.length === named.elements.length) {
    return undefined;
  }

  return factory.updateImportDeclaration(
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
}

function insertImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  record: ModuleRequirements,
): ts.SourceFile {
  const elements = Array.from(record.required).map((name) =>
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
