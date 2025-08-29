import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "@commontools/schema-generator";
import { typeToJsonSchema } from "../typescript/transformer/schema-generator.ts";

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

// Helper to get a type from an interface declaration
function getTypeFromCode(
  code: string,
  typeName: string,
): { type: ts.Type; checker: ts.TypeChecker; typeNode?: ts.TypeNode } {
  const { program, checker, sourceFile } = createTestProgram(code);

  // Find the interface declaration
  let foundType: ts.Type | undefined;
  let foundTypeNode: ts.TypeNode | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) {
        foundType = checker.getDeclaredTypeOfSymbol(symbol);
        // For interfaces, we don't have a direct type node, so we'll leave it undefined
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

describe("Schema Generator V2 Integration", () => {
  it("should produce identical output for simple interface with primitive types", () => {
    const code = `
      interface CounterEvent {
        increment: number;
      }
    `;

    const { type, checker, typeNode } = getTypeFromCode(code, "CounterEvent");

    // Test old system
    const oldResult = typeToJsonSchema(type, checker, typeNode);

    // Test new system
    const newTransformer = createSchemaTransformerV2();
    const newResult = newTransformer(type, checker, typeNode);

    console.log("Old system output:", JSON.stringify(oldResult, null, 2));
    console.log("New system output:", JSON.stringify(newResult, null, 2));

    // For now, we expect them to be compatible, not necessarily identical
    // This will help us identify what needs to be fixed
    expect(newResult.type).toBe(oldResult.type);

    if (oldResult.properties) {
      expect(newResult.properties).toBeDefined();
      // Check that our new system has the same property types
      for (const [key, oldProp] of Object.entries(oldResult.properties)) {
        expect(newResult.properties?.[key]).toBeDefined();
        expect(newResult.properties?.[key]?.type).toBe((oldProp as any).type);
      }
    }
  });

  it("should produce compatible output for interface with required properties", () => {
    const code = `
      interface CounterState {
        value: number;
      }
    `;

    const { type, checker, typeNode } = getTypeFromCode(code, "CounterState");

    // Test old system
    const oldResult = typeToJsonSchema(type, checker, typeNode);

    // Test new system
    const newTransformer = createSchemaTransformerV2();
    const newResult = newTransformer(type, checker, typeNode);

    // Check basic structure
    expect(newResult.type).toBe(oldResult.type);
    expect(newResult.properties).toBeDefined();

    // Check required properties
    if (oldResult.required) {
      expect(newResult.required).toBeDefined();
      // Our system should have the same required properties
      for (const requiredProp of oldResult.required) {
        expect(newResult.required).toContain(requiredProp);
      }
    }
  });

  it("should handle array types when typeNode is available", () => {
    const code = `
      interface TodoItem {
        title: string;
        done: boolean;
      }
      
      type TodoList = TodoItem[];
    `;

    const { type, checker, typeNode } = getTypeFromCode(code, "TodoList");

    // Test new system with typeNode
    const newTransformer = createSchemaTransformerV2();
    const newResult = newTransformer(type, checker, typeNode);

    console.log("Array test - newResult:", JSON.stringify(newResult, null, 2));

    // Since we have the typeNode, this should be detected as an array
    expect(newResult.type).toBe("array");
    expect(newResult.items).toBeDefined();

    // The items should be the TodoItem interface
    expect(newResult.items?.type).toBe("object");
    expect(newResult.items?.properties?.title?.type).toBe("string");
    expect(newResult.items?.properties?.done?.type).toBe("boolean");
  });
});
