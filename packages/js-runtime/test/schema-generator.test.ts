import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { typeToJsonSchema } from "../typescript/transformer/schema-generator.ts";

// Helper to create a minimal TypeScript program for testing
function createTestProgram(code: string): { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true
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
function getTypeFromCode(code: string, typeName: string): { type: ts.Type; checker: ts.TypeChecker } {
  const { program, checker, sourceFile } = createTestProgram(code);
  
  // Find the type alias or interface declaration
  let foundType: ts.Type | undefined;
  
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
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

  return { type: foundType, checker };
}

describe("typeToJsonSchema", () => {
  describe("primitive types", () => {
    it("should convert string type", () => {
      const { type, checker } = getTypeFromCode("type MyString = string;", "MyString");
      const schema = typeToJsonSchema(type, checker);
      expect(schema).toEqual({ type: "string" });
    });

    it("should convert number type", () => {
      const { type, checker } = getTypeFromCode("type MyNumber = number;", "MyNumber");
      const schema = typeToJsonSchema(type, checker);
      expect(schema).toEqual({ type: "number" });
    });

    it("should convert boolean type", () => {
      const { type, checker } = getTypeFromCode("type MyBoolean = boolean;", "MyBoolean");
      const schema = typeToJsonSchema(type, checker);
      expect(schema).toEqual({ type: "boolean" });
    });
  });

  describe("object types", () => {
    it("should convert simple interface", () => {
      const code = `
        interface User {
          name: string;
          age: number;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "User");
      const schema = typeToJsonSchema(type, checker);
      
      expect(schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" }
        },
        required: ["name", "age"]
      });
    });

    it("should handle optional properties", () => {
      const code = `
        interface User {
          name: string;
          age?: number;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "User");
      const schema = typeToJsonSchema(type, checker);
      
      expect(schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" }
        },
        required: ["name"]
      });
    });
  });

  describe("recursive types", () => {
    it.skip("should handle simple recursive type (currently causes stack overflow)", () => {
      const code = `
        interface LinkedList {
          value: number;
          next?: LinkedList;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "LinkedList");
      
      // This currently causes a stack overflow
      // After implementing cycle detection, we expect it to return a schema
      const schema = typeToJsonSchema(type, checker);
      expect(typeof schema).toBe("object");
    });
    
    it("should detect cycles with explicit seenTypes parameter", () => {
      const code = `
        interface LinkedList {
          value: number;
          next?: LinkedList;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "LinkedList");
      
      // Test with a seenTypes set that already contains the type
      const seenTypes = new Set<ts.Type>();
      seenTypes.add(type);
      
      // When we pass a type that's already in seenTypes, it should return a placeholder
      const schema = typeToJsonSchema(type, checker, undefined, 0, seenTypes);
      
      // For now, expect a placeholder object
      expect(schema).toEqual({ 
        type: "object", 
        additionalProperties: true,
        $comment: "Recursive type detected - placeholder schema"
      });
    });
    
    it("should handle same type in different branches (not a real cycle)", () => {
      const code = `
        interface B {
          value: string;
        }
        
        interface A {
          b1: B;
          b2: B;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "A");
      
      const schema = typeToJsonSchema(type, checker);
      
      // B is used in both b1 and b2, but this isn't a cycle
      // We should get the full schema for B in both places
      expect(schema).toEqual({
        type: "object",
        properties: {
          b1: {
            type: "object",
            properties: {
              value: { type: "string" }
            },
            required: ["value"]
          },
          b2: {
            type: "object",
            properties: {
              value: { type: "string" }
            },
            required: ["value"]
          }
        },
        required: ["b1", "b2"]
      });
    });
  });
});
