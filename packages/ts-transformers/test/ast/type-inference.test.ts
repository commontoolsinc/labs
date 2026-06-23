import { assertEquals } from "@std/assert";
import ts from "typescript";

import { isCollectionType } from "../../src/ast/mod.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

/** Resolve the declared type of a top-level `declare const <name>: T`. */
function declaredType(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  name: string,
): ts.Type {
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = checker.getTypeAtLocation(node.name);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error(`Declaration for ${name} not found`);
  }
  return found;
}

// `noLib` is on, so the array forms are recognized only because we declare the
// global Array/ReadonlyArray interfaces here — mirroring call-kind.test.ts.
const SOURCE = `
  interface Array<T> { length: number; }
  interface ReadonlyArray<T> { length: number; }

  declare const arr: string[];
  declare const readonlyArr: readonly string[];
  declare const tuple: [string, number];
  declare const unionOfArrays: string[] | number[];
  declare const unionWithScalar: string | string[];
  declare const scalar: string;
  declare const obj: { a: number };
`;

Deno.test("isCollectionType: array and tuple result types are collections", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "arr"), checker),
    true,
  );
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "readonlyArr"), checker),
    true,
  );
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "tuple"), checker),
    true,
  );
});

Deno.test("isCollectionType: a union whose every member is an array/tuple is a collection", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  // The union arm — `a ?? b` over differently-typed arrays resolves to
  // `string[] | number[]`, which `checker.isArrayType` returns false for.
  assertEquals(
    isCollectionType(
      declaredType(sourceFile, checker, "unionOfArrays"),
      checker,
    ),
    true,
  );
});

Deno.test("isCollectionType: scalars, objects, and mixed unions are not collections", () => {
  const { sourceFile, checker } = createProgram(SOURCE);
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "scalar"), checker),
    false,
  );
  assertEquals(
    isCollectionType(declaredType(sourceFile, checker, "obj"), checker),
    false,
  );
  // A union with even one non-array member is not a collection.
  assertEquals(
    isCollectionType(
      declaredType(sourceFile, checker, "unionWithScalar"),
      checker,
    ),
    false,
  );
});

Deno.test("isCollectionType: an undefined type is not a collection", () => {
  const { checker } = createProgram(SOURCE);
  assertEquals(isCollectionType(undefined, checker), false);
});
