import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/opaque-ref/dependency.ts";

export interface AnalysisHarnessResult {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly expression: ts.Expression;
  readonly analysis: ReturnType<ReturnType<typeof createDataFlowAnalyzer>>;
}

interface AnalyseOptions {
  readonly prelude?: string;
}

export function analyseExpression(
  source: string,
  options: AnalyseOptions = {},
): AnalysisHarnessResult {
  const fileName = "/analysis.ts";
  const programSource = `
interface OpaqueRefMethods<T> {
  map<S>(fn: (...args: unknown[]) => S): OpaqueRef<S[]>;
}

type OpaqueRef<T> = {
  readonly __opaque: T;
} & OpaqueRefMethods<T>;

declare const state: {
  readonly count: OpaqueRef<number>;
  readonly flag: OpaqueRef<boolean>;
  readonly items: OpaqueRef<number[]>;
};

declare function ifElse<T>(predicate: boolean, whenTrue: T, whenFalse: T): T;
declare function recipe<T>(body: () => T): T;

${options.prelude ?? ""}

const result = ${source};
`;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    noLib: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    programSource,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TS,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? programSource : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  const checker = program.getTypeChecker();

  const declaration = sourceFile.statements
    .filter((statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement)
    )
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .find((decl) => decl.initializer && ts.isExpression(decl.initializer));

  if (!declaration?.initializer || !ts.isExpression(declaration.initializer)) {
    throw new Error("Expected initializer expression");
  }

  const expression = declaration.initializer;
  const analyze = createDataFlowAnalyzer(checker);
  const analysis = analyze(expression);

  return { sourceFile, checker, expression, analysis };
}
