import type ts from "typescript";
// Typescript-free contract module (see engine.ts) — safe to import eagerly
// without pulling the compiler stack onto this module's graph.
import { sourceHasIgnoredDisableDirective } from "@commonfabric/ts-transformers/runtime-contract";
import { compilerStack } from "./deferred-compiler-stack.ts";
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
  // Deferred compiler stack (parses + prints): pretransform only runs on
  // compile flows, which await ensureCompilerStack() at their entry.
  const { transformCfDirective } = compilerStack();
  return {
    main: program.main,
    files: program.files.map((source) => {
      if (source.name.endsWith(".d.ts")) {
        return { name: source.name, contents: source.contents };
      }
      // `/// <cf-disable-transform />` disables the transform only at column
      // zero (matching TypeScript's triple-slash directives). An indented
      // first-line lookalike is silently ignored — the file transforms as
      // usual — so warn an author who meant to opt this file out.
      if (sourceHasIgnoredDisableDirective(source.contents)) {
        console.warn(
          `${source.name}: an indented "/// <cf-disable-transform />" is ` +
            `ignored; the directive disables the transform only at column ` +
            `zero. Move it to the start of the line to opt this file out.`,
        );
      }
      return {
        name: source.name,
        contents: normalizeMixedModuleImports(
          transformCfDirective(source.contents, source.name),
        ),
      };
    }),
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
  const { ts: tsc } = compilerStack();
  const sourceFile = tsc.createSourceFile(
    "source.tsx",
    source,
    tsc.ScriptTarget.ES2023,
    true,
    tsc.ScriptKind.TSX,
  );
  const printer = tsc.createPrinter({ newLine: tsc.NewLineKind.LineFeed });
  const replacements: { start: number; end: number; text: string }[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !tsc.isImportDeclaration(statement) ||
      !statement.importClause ||
      !statement.importClause.namedBindings ||
      !tsc.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    const { importClause } = statement;
    const namedBindings = importClause.namedBindings as ts.NamedImports;

    let rewrittenStatements: ts.ImportDeclaration[] | undefined;
    if (importClause.name) {
      rewrittenStatements = [
        tsc.factory.createImportDeclaration(
          statement.modifiers,
          tsc.factory.createImportClause(
            importClause.isTypeOnly,
            tsc.factory.createIdentifier(importClause.name.text),
            undefined,
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
        tsc.factory.createImportDeclaration(
          statement.modifiers,
          tsc.factory.createImportClause(
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
        tsc.factory.createImportDeclaration(
          statement.modifiers,
          tsc.factory.createImportClause(
            importClause.isTypeOnly || defaultSpecifier.isTypeOnly,
            tsc.factory.createIdentifier(defaultSpecifier.name.text),
            undefined,
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
      ];

      if (remainingElements.length > 0) {
        rewrittenStatements.push(
          tsc.factory.createImportDeclaration(
            statement.modifiers,
            tsc.factory.createImportClause(
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
          printer.printNode(tsc.EmitHint.Unspecified, entry, sourceFile)
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
  const { ts: tsc } = compilerStack();
  return tsc.isStringLiteral(moduleSpecifier)
    ? tsc.factory.createStringLiteral(moduleSpecifier.text)
    : moduleSpecifier;
}

function cloneImportAttributes(
  attributes: ts.ImportAttributes | undefined,
  sourceFile: ts.SourceFile,
): ts.ImportAttributes | undefined {
  const { ts: tsc } = compilerStack();
  if (!attributes) return undefined;
  const cloned = tsc.factory.createImportAttributes(
    tsc.factory.createNodeArray(
      attributes.elements.map((element) =>
        tsc.factory.createImportAttribute(
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
  const { ts: tsc } = compilerStack();
  return tsc.factory.createNamedImports(
    elements.map((element) =>
      tsc.factory.createImportSpecifier(
        element.isTypeOnly,
        element.propertyName
          ? cloneModuleExportName(element.propertyName, sourceFile)
          : undefined,
        tsc.factory.createIdentifier(element.name.text),
      )
    ),
  );
}

function cloneModuleExportName(
  name: ts.ModuleExportName,
  sourceFile: ts.SourceFile,
): ts.ModuleExportName {
  const { ts: tsc } = compilerStack();
  return tsc.isIdentifier(name)
    ? tsc.factory.createIdentifier(name.text)
    : tsc.factory.createStringLiteral(name.text ?? name.getText(sourceFile));
}

function cloneImportAttributeValue(value: ts.Expression): ts.Expression {
  const { ts: tsc } = compilerStack();
  if (tsc.isStringLiteral(value)) {
    return tsc.factory.createStringLiteral(value.text);
  }
  return value;
}

export function preserveLineCount(
  original: string,
  replacement: string,
): string {
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
