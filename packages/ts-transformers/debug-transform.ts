import ts from "typescript";
import { CommonToolsTransformerPipeline } from "./src/mod.ts";

const code = `
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const factors = [2, 3, 4];

  const result = derive(value, (v) => v * factors[1]);

  return result;
}
`;

const sourceFile = ts.createSourceFile(
  "test.tsx",
  code,
  ts.ScriptTarget.Latest,
  true,
);

const program = ts.createProgram(["test.tsx"], {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.React,
}, {
  getSourceFile: (fileName) => fileName === "test.tsx" ? sourceFile : undefined,
  writeFile: () => {},
  getCurrentDirectory: () => Deno.cwd(),
  getDirectories: () => [],
  fileExists: () => true,
  readFile: () => code,
  getCanonicalFileName: (f) => f,
  useCaseSensitiveFileNames: () => true,
  getNewLine: () => "\n",
});

const checker = program.getTypeChecker();
const pipeline = new CommonToolsTransformerPipeline();

console.log("=== TRANSFORMING ===\n");

const result = ts.transform(sourceFile, [
  (context) => pipeline.createTransformer(context, checker),
]);

const printer = ts.createPrinter();
const transformed = printer.printFile(result.transformed[0]!);

console.log("\n=== RESULT ===\n");
console.log(transformed);
