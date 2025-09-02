import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "@commontools/schema-generator";
import { typeToJsonSchema } from "../typescript/transformer/schema-generator.ts";
import { describe, it } from "@std/testing/bdd";
import type { Cell } from "@commontools/api";

/**
 * Test to compare our new system against the old system for complex Cell<Array<{...}>> types
 * This will help us identify exactly what's different and what needs to be fixed
 */
describe("Schema Generator Cell Array Comparison", () => {
  it("should compare old vs new system for Cell<Array<{...}>>", () => {
    const code = `
      // Minimal Cell<T> definition for test purposes
      interface Cell<T> {
        get(): T;
        set(value: T): void;
      }

      interface TestInterface {
        users: Cell<Array<{
          id: string;
          name: string;
        }>>;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "TestInterface");
    const generator = createSchemaTransformerV2();

    // Test old system
    const oldResult = typeToJsonSchema(type, checker);

    // Test new system
    const newResult = generator(type, checker);

    console.log("=== OLD SYSTEM OUTPUT ===");
    console.log(JSON.stringify(oldResult, null, 2));
    console.log("\n=== NEW SYSTEM OUTPUT ===");
    console.log(JSON.stringify(newResult, null, 2));

    // Let's see what the old system actually produces
    // This will tell us what our new system should be producing
    expect(oldResult).toBeDefined();
    expect(newResult).toBeDefined();

    // For now, just log the differences to understand what's happening
    console.log("\n=== ANALYSIS ===");
    console.log("Old system users property:", oldResult.properties?.users);
    console.log("New system users property:", newResult.properties?.users);
  });

  it("should compare old vs new system for simple Cell<string>", () => {
    const code = `
      // Minimal Cell<T> definition for test purposes
      interface Cell<T> {
        get(): T;
        set(value: T): void;
      }

      interface SimpleInterface {
        name: Cell<string>;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "SimpleInterface");
    const generator = createSchemaTransformerV2();

    // Test old system
    const oldResult = typeToJsonSchema(type, checker);

    // Test new system
    const newResult = generator(type, checker);

    console.log("=== SIMPLE CELL COMPARISON ===");
    console.log("Old system name property:", oldResult.properties?.name);
    console.log("New system name property:", newResult.properties?.name);

    // This should work since we fixed basic Cell<T> types
    expect(newResult.properties?.name?.asCell).toBe(true);
  });
});

// Helper to create a minimal TypeScript program for testing
function createTestProgram(
  code: string,
): { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => name === fileName ? sourceFile : undefined,
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: () => true,
    readFile: () => "",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  }, compilerHost);

  return {
    program,
    checker: program.getTypeChecker(),
    sourceFile: sourceFile!,
  };
}

// Helper to get a type from an interface or type alias declaration
function getTypeFromCode(
  code: string,
  typeName: string,
): { type: ts.Type; checker: ts.TypeChecker; typeNode?: ts.TypeNode } {
  const { program, checker, sourceFile } = createTestProgram(code);

  // Find the interface or type alias declaration
  let foundType: ts.Type | undefined;
  let foundTypeNode: ts.TypeNode | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) {
        foundType = checker.getDeclaredTypeOfSymbol(symbol);
      }
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
      foundTypeNode = node.type;
    }
  });

  if (!foundType) {
    throw new Error(`Type ${typeName} not found in code`);
  }

  return { type: foundType, checker, typeNode: foundTypeNode };
}
