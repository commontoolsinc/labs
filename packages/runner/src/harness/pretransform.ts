import { transformCfDirective } from "@commonfabric/ts-transformers";
import ts from "typescript";
import { RuntimeProgram } from "./types.ts";

export function pretransformProgram(
  program: RuntimeProgram,
  id: string,
): RuntimeProgram {
  program = transformInjectHelperModule(program);
  program = transformProgramWithPrefix(program, id);
  return program;
}

// For each source file in the program, inject the internal helper import used
// by the AST transformer by default. Files can explicitly opt out with
// `/// <cf-disable-transform />`.
export function transformInjectHelperModule(
  program: RuntimeProgram,
): RuntimeProgram {
  return {
    main: program.main,
    files: program.files.map((source) => ({
      name: source.name,
      contents: source.name.endsWith(".d.ts")
        ? source.contents
        : normalizeMixedModuleImports(transformCfDirective(source.contents)),
    })),
    mainExport: program.mainExport,
  };
}

// Adds `id` as a prefix to all files in the program.
// Injects a new entry at root `/index.ts` to re-export
// the entry contents because otherwise `typescript`
// flattens the output, eliding the common prefix.
export function transformProgramWithPrefix(
  program: RuntimeProgram,
  id: string,
): RuntimeProgram {
  const main = program.main;
  const exportNameds = `export * from "${prefix(main, id)}";`;
  const exportDefault = `export { default } from "${prefix(main, id)}";`;
  const hasDefault = !program.mainExport || program.mainExport === "default";
  const files = [
    ...program.files.map((source) => ({
      name: prefix(source.name, id),
      contents: source.contents,
    })),
    {
      name: `/index.ts`,
      contents: `${exportNameds}${hasDefault ? `\n${exportDefault}` : ""}`,
    },
  ];
  return {
    main: `/index.ts`,
    files,
  };
}

function prefix(filename: string, id: string): string {
  return `/${id}${filename}`;
}

function normalizeMixedModuleImports(source: string): string {
  const sourceFile = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TSX,
  );
  let changed = false;
  const statements = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !statement.importClause.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      return [statement];
    }

    const { importClause } = statement;
    const namedBindings = importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      return [statement];
    }

    if (importClause.name) {
      changed = true;
      return [
        ts.factory.createImportDeclaration(
          statement.modifiers,
          ts.factory.createImportClause(
            importClause.isTypeOnly,
            importClause.name,
            undefined,
          ),
          statement.moduleSpecifier,
          statement.attributes,
        ),
        ts.factory.createImportDeclaration(
          statement.modifiers,
          ts.factory.createImportClause(
            importClause.isTypeOnly,
            undefined,
            namedBindings,
          ),
          statement.moduleSpecifier,
          statement.attributes,
        ),
      ];
    }

    const defaultSpecifier = namedBindings.elements.find((
      element,
    ) => element.propertyName?.text === "default");
    if (!defaultSpecifier) {
      return [statement];
    }

    changed = true;
    const remainingElements = namedBindings.elements.filter((
      element,
    ) => element !== defaultSpecifier);
    const rewrittenStatements = [
      ts.factory.createImportDeclaration(
        statement.modifiers,
        ts.factory.createImportClause(
          importClause.isTypeOnly || defaultSpecifier.isTypeOnly,
          defaultSpecifier.name,
          undefined,
        ),
        statement.moduleSpecifier,
        statement.attributes,
      ),
    ];

    if (remainingElements.length > 0) {
      rewrittenStatements.push(
        ts.factory.createImportDeclaration(
          statement.modifiers,
          ts.factory.createImportClause(
            importClause.isTypeOnly,
            undefined,
            ts.factory.createNamedImports(remainingElements),
          ),
          statement.moduleSpecifier,
          statement.attributes,
        ),
      );
    }

    return rewrittenStatements;
  });

  if (!changed) {
    return source;
  }

  return ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
  }).printFile(ts.factory.updateSourceFile(sourceFile, statements));
}
