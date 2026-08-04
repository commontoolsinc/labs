import ts from "typescript";

/**
 * Compiler options for the emit test. ES modules and an ESNext target keep the
 * output close to the source, and `jsx` matches the workspace setting so markup
 * in a `.tsx` file compiles to calls. `alwaysStrict` is off to match Deno,
 * which loads every file as an ES module and so emits no `"use strict"` line
 * for a file that has no import or export.
 */
const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  alwaysStrict: false,
};

/**
 * Whether a source file compiles to code that can run.
 *
 * A file holding only interfaces, type aliases, and other declarations compiles
 * to an empty module, so it has no statement any test could execute, and Deno's
 * coverage reports no line for it that a test could leave uncovered.
 *
 * The answer comes from compiling the file and reading what comes out. Which
 * constructs reach the output is the compiler's rule. An enum, a namespace
 * holding a value, and an import kept for its side effects all emit code. A
 * type-only import, a namespace holding only types, and a comment do not.
 *
 * The coverage gate is the caller; `docs/development/COVERAGE.md` describes what
 * it does with the answer.
 */
export function hasExecutableCode(content: string, filePath: string): boolean {
  const emitted = ts.transpileModule(content, {
    fileName: filePath,
    compilerOptions: TRANSPILE_OPTIONS,
  }).outputText;

  const parsed = ts.createSourceFile(
    "emitted.js",
    emitted,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  );
  return parsed.statements.some((statement) => !isEmptyExportMarker(statement));
}

/**
 * An `export {}` with nothing in it. The compiler emits this to keep a file
 * that emitted nothing else a module rather than a script. It declares no
 * binding and runs no code.
 */
function isEmptyExportMarker(statement: ts.Statement): boolean {
  return ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier === undefined &&
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length === 0;
}
