import { assertEquals, assertStrictEquals } from "@std/assert";
import ts from "typescript";

import { numberFromExpression } from "../../src/typescript/numeric-expression.ts";

/**
 * Build a checker over a single synthetic file. No default library is
 * supplied, so an unshadowed `NaN`/`Infinity` resolves to no symbol at all —
 * which is what the helper treats as "the global".
 */
function createProgram(source: string): {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.fileExists = (name) => name === fileName;
  host.getDirectories = () => [];
  host.getCurrentDirectory = () => "/";
  host.writeFile = () => {};

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { checker: program.getTypeChecker(), sourceFile };
}

/** Evaluate the initializer of `const <name> = ...` in `source`. */
function evaluate(source: string, name: string): number | undefined {
  const { checker, sourceFile } = createProgram(source);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) throw new Error(`no initializer for ${name}`);
  return numberFromExpression(initializer, checker);
}

/** Evaluate `const v = <expr>;` — the common single-expression case. */
function evaluateExpr(expr: string): number | undefined {
  return evaluate(`const v = ${expr};`, "v");
}

Deno.test("numberFromExpression: unsigned literals", () => {
  assertStrictEquals(evaluateExpr("5"), 5);
  assertStrictEquals(evaluateExpr("0"), 0);
  assertStrictEquals(evaluateExpr("1.5"), 1.5);
  assertStrictEquals(evaluateExpr("0x10"), 16);
  assertStrictEquals(evaluateExpr("1e3"), 1000);
});

Deno.test("numberFromExpression: signed literals", () => {
  assertStrictEquals(evaluateExpr("-5"), -5);
  assertStrictEquals(evaluateExpr("-1"), -1);
  assertStrictEquals(evaluateExpr("-0.5"), -0.5);
  assertStrictEquals(evaluateExpr("+5"), 5);
  // Nested signs fold rather than bailing.
  assertStrictEquals(evaluateExpr("- -5"), 5);
  assertStrictEquals(evaluateExpr("-+-5"), 5);
});

Deno.test("numberFromExpression: signed zero keeps its sign", () => {
  // The whole point of the value model: -0 and 0 are distinct stored values.
  assertEquals(Object.is(evaluateExpr("-0"), -0), true);
  assertEquals(Object.is(evaluateExpr("0"), 0), true);
  assertEquals(Object.is(evaluateExpr("-0"), 0), false);
  assertEquals(Object.is(evaluateExpr("- -0"), 0), true);
});

Deno.test("numberFromExpression: non-finite globals", () => {
  assertEquals(Number.isNaN(evaluateExpr("NaN")), true);
  assertStrictEquals(evaluateExpr("Infinity"), Infinity);
  assertStrictEquals(evaluateExpr("-Infinity"), -Infinity);
  assertStrictEquals(evaluateExpr("+Infinity"), Infinity);
  assertEquals(Number.isNaN(evaluateExpr("-NaN")), true);
});

Deno.test("numberFromExpression: shadowed non-finite globals do not fold", () => {
  // A local binding named `NaN` denotes 111 here, not the global. Folding it
  // to the global would be silently wrong, so the helper declines instead.
  assertStrictEquals(
    evaluate("const NaN = 111; const v = NaN;", "v"),
    undefined,
  );
  assertStrictEquals(
    evaluate("const Infinity = 222; const v = Infinity;", "v"),
    undefined,
  );
  assertStrictEquals(
    evaluate("const Infinity = 222; const v = -Infinity;", "v"),
    undefined,
  );
});

Deno.test("numberFromExpression: declines non-numeric expressions", () => {
  assertStrictEquals(evaluateExpr(`"5"`), undefined);
  assertStrictEquals(evaluateExpr("true"), undefined);
  assertStrictEquals(evaluateExpr("null"), undefined);
  assertStrictEquals(evaluateExpr("someName"), undefined);
  assertStrictEquals(evaluateExpr("2 + 3"), undefined);
  assertStrictEquals(evaluateExpr("f()"), undefined);
});

Deno.test("numberFromExpression: declines non-sign prefix operators", () => {
  assertStrictEquals(evaluateExpr("~5"), undefined);
  assertStrictEquals(evaluateExpr("!5"), undefined);
  assertStrictEquals(evaluateExpr(`-"5"`), undefined);
});
