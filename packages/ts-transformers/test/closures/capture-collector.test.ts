import { assertEquals } from "@std/assert";
import ts from "typescript";

import {
  CaptureCollector,
  createModuleScopedReactiveCaptureCollector,
} from "../../src/closures/capture-collector.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    noImplicitAny: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TS,
  );

  const host: ts.CompilerHost = {
    getSourceFile: (name) => name === fileName ? sourceFile : undefined,
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => name === fileName,
    readFile: (name) => name === fileName ? source : undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function findPatternToolCallback(sourceFile: ts.SourceFile): ts.ArrowFunction {
  let callback: ts.ArrowFunction | undefined;

  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "patternTool"
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isArrowFunction(arg)) {
        callback = arg;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!callback) {
    throw new Error("expected to find patternTool callback");
  }

  return callback;
}

function captureTexts(
  captures: readonly ts.Expression[],
  sourceFile: ts.SourceFile,
): string[] {
  return [...captures]
    .map((capture) => capture.getText(sourceFile))
    .sort();
}

function captureRootNames(
  captureTree: ReadonlyMap<string, unknown>,
): string[] {
  return [...captureTree.keys()].sort();
}

Deno.test(
  "CaptureCollector can isolate module-scoped reactive captures for patternTool policy",
  () => {
    const { sourceFile, checker } = createProgram(`
      type Cell<T> = T & { readonly __brand: "Cell" };
      declare function patternTool<T>(fn: T): T;

      const content = "" as Cell<string>;
      const plain = "prefix";

      const tool = patternTool(({ value }: { value: string }) => {
        const local = content;
        const nested = () => content;
        return value + plain + local + nested();
      });
    `);

    const callback = findPatternToolCallback(sourceFile);

    const defaultCollector = new CaptureCollector(checker);
    const defaultAnalysis = defaultCollector.analyze(callback);
    assertEquals(
      captureRootNames(defaultAnalysis.captureTree),
      [],
    );

    const patternToolCollector = createModuleScopedReactiveCaptureCollector(
      checker,
      (_identifier, type, checker) =>
        checker.typeToString(type).includes("Cell<"),
    );
    const patternToolAnalysis = patternToolCollector.analyze(callback);

    assertEquals(
      captureRootNames(patternToolAnalysis.captureTree),
      ["content"],
    );
    assertEquals(
      captureTexts([...patternToolAnalysis.captures], sourceFile),
      ["content", "content"],
    );
  },
);
