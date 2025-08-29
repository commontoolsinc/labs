import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "../src/plugin.ts";

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

// Helper to get a type from a type alias declaration
function getTypeFromCode(
  code: string,
  typeName: string,
): {
  type: ts.Type;
  checker: ts.TypeChecker;
  typeNode: ts.TypeNode | undefined;
} {
  const { program, checker, sourceFile } = createTestProgram(code);

  // Find the type alias or interface declaration
  let foundType: ts.Type | undefined;
  let foundTypeNode: ts.TypeNode | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
      foundTypeNode = node.type;
    } else if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      // For interfaces, we need to get the type from the symbol
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) {
        foundType = checker.getDeclaredTypeOfSymbol(symbol);
      }
    }
  });

  if (!foundType) {
    throw new Error(`Type ${typeName} not found in code`);
  }

  return { type: foundType, checker, typeNode: foundTypeNode };
}

describe("Plugin Interface", () => {
  it("should create a transformer function with the correct signature", () => {
    const transformer = createSchemaTransformerV2();

    // Verify it's a function
    expect(typeof transformer).toBe("function");

    // Verify it has the right number of parameters
    expect(transformer.length).toBe(3);
  });

  it("should transform primitive types correctly", () => {
    const transformer = createSchemaTransformerV2();
    const { type, checker } = getTypeFromCode(
      "type MyString = string;",
      "MyString",
    );

    const schema = transformer(type, checker);
    expect(schema.type).toBe("string");
  });

  it("should transform object types correctly", () => {
    const transformer = createSchemaTransformerV2();
    const { type, checker } = getTypeFromCode(
      "interface MyObject { name: string; age: number; }",
      "MyObject",
    );

    const schema = transformer(type, checker);
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.name).toEqual({ type: "string" });
    expect(schema.properties?.age).toEqual({ type: "number" });
  });

  it("should transform array types correctly", () => {
    const transformer = createSchemaTransformerV2();
    const { type, checker, typeNode } = getTypeFromCode(
      "type MyArray = string[];",
      "MyArray",
    );

    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toBeDefined();
  });
});
