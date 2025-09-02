import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";

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
        // For interfaces, we don't have a direct type node, so we'll leave it undefined
        // The interface itself is not a TypeNode, it's a Declaration
      }
    }
  });

  if (!foundType) {
    throw new Error(`Type ${typeName} not found in code`);
  }

  return { type: foundType, checker, typeNode: foundTypeNode };
}

describe("SchemaGenerator", () => {
  describe("formatter chain", () => {
    it("should route primitive types to PrimitiveFormatter", () => {
      const generator = new SchemaGenerator();
      const { type, checker } = getTypeFromCode(
        "type MyString = string;",
        "MyString",
      );

      const schema = generator.generateSchema(type, checker);
      expect(schema.type).toBe("string");
    });

    it("should route object types to ObjectFormatter", () => {
      const generator = new SchemaGenerator();
      const { type, checker } = getTypeFromCode(
        "interface MyObject { name: string; age: number; }",
        "MyObject",
      );

      const schema = generator.generateSchema(type, checker);
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.properties?.age).toEqual({ type: "number" });
    });

    it("should route array types to ArrayFormatter", () => {
      const generator = new SchemaGenerator();
      const { type, checker, typeNode } = getTypeFromCode(
        "type MyArray = string[];",
        "MyArray",
      );

      const schema = generator.generateSchema(type, checker, typeNode);
      expect(schema.type).toBe("array");
      expect(schema.items).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should handle unknown types gracefully", () => {
      const generator = new SchemaGenerator();
      // Use a real TypeScript 'unknown' type which the engine doesn't
      // specialize and should therefore fall back safely.
      const { type, checker, typeNode } = getTypeFromCode(
        "type T = unknown;",
        "T",
      );
      const schema = generator.generateSchema(type, checker, typeNode);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(true);
    });
  });
});
