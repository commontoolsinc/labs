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
        : normalizeMixedModuleImports(
          transformCfDirective(source.contents, source.name),
        ),
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

// ESM variant: inject the helper import and prefix files with `id` (so source
// locations / identity match the AMD path), but DO NOT add the synthetic
// `/index.ts` re-export. That index exists only to defeat `outFile` prefix
// flattening in the AMD bundler; a per-module ESM graph has no bundle, so the
// program entry is simply the prefixed main module.
export function pretransformProgramForModules(
  program: RuntimeProgram,
  id: string,
): RuntimeProgram {
  program = transformInjectHelperModule(program);
  return {
    main: prefix(program.main, id),
    files: program.files.map((source) => ({
      name: prefix(source.name, id),
      contents: source.contents,
    })),
    ...(program.mainExport !== undefined
      ? { mainExport: program.mainExport }
      : {}),
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
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const replacements: { start: number; end: number; text: string }[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !statement.importClause.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    const { importClause } = statement;
    const namedBindings = importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    let rewrittenStatements: ts.ImportDeclaration[] | undefined;
    if (importClause.name) {
      rewrittenStatements = [
        ts.factory.createImportDeclaration(
          statement.modifiers,
          ts.factory.createImportClause(
            importClause.isTypeOnly,
            ts.factory.createIdentifier(importClause.name.text),
            undefined,
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
        ts.factory.createImportDeclaration(
          statement.modifiers,
          ts.factory.createImportClause(
            importClause.isTypeOnly,
            undefined,
            cloneNamedImports(namedBindings, sourceFile),
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
      ];
    } else {
      const defaultSpecifier = namedBindings.elements.find((
        element,
      ) => element.propertyName?.text === "default");
      if (!defaultSpecifier) {
        continue;
      }

      const remainingElements = namedBindings.elements.filter((
        element,
      ) => element !== defaultSpecifier);
      rewrittenStatements = [
        ts.factory.createImportDeclaration(
          statement.modifiers,
          ts.factory.createImportClause(
            importClause.isTypeOnly || defaultSpecifier.isTypeOnly,
            ts.factory.createIdentifier(defaultSpecifier.name.text),
            undefined,
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
      ];

      if (remainingElements.length > 0) {
        rewrittenStatements.push(
          ts.factory.createImportDeclaration(
            statement.modifiers,
            ts.factory.createImportClause(
              importClause.isTypeOnly,
              undefined,
              cloneNamedImportsFromElements(remainingElements, sourceFile),
            ),
            cloneModuleSpecifier(statement.moduleSpecifier),
            cloneImportAttributes(statement.attributes, sourceFile),
          ),
        );
      }
    }

    const start = statement.getStart(sourceFile);
    const end = statement.getEnd();
    replacements.push({
      start,
      end,
      text: preserveLineCount(
        source.slice(start, end),
        rewrittenStatements.map((entry) =>
          printer.printNode(ts.EmitHint.Unspecified, entry, sourceFile)
        ).join(" "),
      ),
    });
  }

  if (replacements.length === 0) return source;

  let out = source;
  for (const replacement of [...replacements].reverse()) {
    out = out.slice(0, replacement.start) + replacement.text +
      out.slice(replacement.end);
  }
  return out;
}

function cloneModuleSpecifier(moduleSpecifier: ts.Expression): ts.Expression {
  return ts.isStringLiteral(moduleSpecifier)
    ? ts.factory.createStringLiteral(moduleSpecifier.text)
    : moduleSpecifier;
}

function cloneImportAttributes(
  attributes: ts.ImportAttributes | undefined,
  sourceFile: ts.SourceFile,
): ts.ImportAttributes | undefined {
  if (!attributes) return undefined;
  const cloned = ts.factory.createImportAttributes(
    ts.factory.createNodeArray(
      attributes.elements.map((element) =>
        ts.factory.createImportAttribute(
          cloneModuleExportName(element.name, sourceFile),
          cloneImportAttributeValue(element.value),
        )
      ),
    ),
    false,
  );
  return Object.assign(cloned, { token: attributes.token });
}

function cloneNamedImports(
  namedImports: ts.NamedImports,
  sourceFile: ts.SourceFile,
): ts.NamedImports {
  return cloneNamedImportsFromElements(namedImports.elements, sourceFile);
}

function cloneNamedImportsFromElements(
  elements: readonly ts.ImportSpecifier[],
  sourceFile: ts.SourceFile,
): ts.NamedImports {
  return ts.factory.createNamedImports(
    elements.map((element) =>
      ts.factory.createImportSpecifier(
        element.isTypeOnly,
        element.propertyName
          ? cloneModuleExportName(element.propertyName, sourceFile)
          : undefined,
        ts.factory.createIdentifier(element.name.text),
      )
    ),
  );
}

function cloneModuleExportName(
  name: ts.ModuleExportName,
  sourceFile: ts.SourceFile,
): ts.ModuleExportName {
  return ts.isIdentifier(name)
    ? ts.factory.createIdentifier(name.text)
    : ts.factory.createStringLiteral(name.text ?? name.getText(sourceFile));
}

function cloneImportAttributeValue(value: ts.Expression): ts.Expression {
  if (ts.isStringLiteral(value)) {
    return ts.factory.createStringLiteral(value.text);
  }
  return value;
}

function preserveLineCount(original: string, replacement: string): string {
  const originalLineCount = original.split(/\r\n|\r|\n/).length;
  const replacementLineCount = replacement.split(/\r\n|\r|\n/).length;
  if (replacementLineCount > originalLineCount) {
    throw new Error(
      `Import rewrite expanded from ${originalLineCount} to ${replacementLineCount} lines`,
    );
  }
  return replacement +
    "\n".repeat(originalLineCount - replacementLineCount);
}
