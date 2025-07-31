import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import {
  getCycles,
  typeToJsonSchema,
} from "../typescript/transformer/schema-generator.ts";

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
): { type: ts.Type; checker: ts.TypeChecker } {
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
      const { type, checker } = getTypeFromCode(
        "type MyString = string;",
        "MyString",
      );
      const schema = typeToJsonSchema(type, checker);
      expect(schema).toEqual({ type: "string" });
    });

    it("should convert number type", () => {
      const { type, checker } = getTypeFromCode(
        "type MyNumber = number;",
        "MyNumber",
      );
      const schema = typeToJsonSchema(type, checker);
      expect(schema).toEqual({ type: "number" });
    });

    it("should convert boolean type", () => {
      const { type, checker } = getTypeFromCode(
        "type MyBoolean = boolean;",
        "MyBoolean",
      );
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
          age: { type: "number" },
        },
        required: ["name", "age"],
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
          age: { type: "number" },
        },
        required: ["name"],
      });
    });
  });

  describe("recursive types", () => {
    it("should handle simple recursive type with cycle detection", () => {
      const code = `
        interface LinkedList {
          value: number;
          next?: LinkedList;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "LinkedList");

      const schema = typeToJsonSchema(type, checker);

      // Should now return proper $ref and definitions
      expect(schema).toEqual({
        "$ref": "#/definitions/LinkedList",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": {
          "LinkedList": {
            "type": "object",
            "properties": {
              "value": { "type": "number" },
              "next": { "$ref": "#/definitions/LinkedList" },
            },
            "required": ["value"],
          },
        },
      });
    });

    it("should handle array of recursive types in typeToJsonSchema", () => {
      const code = `
        interface TreeNode {
          value: number;
          children: TreeNode[];
        }
      `;
      const { type, checker } = getTypeFromCode(code, "TreeNode");

      const schema = typeToJsonSchema(type, checker);

      // Should return proper $ref and definitions
      expect(schema).toEqual({
        "$ref": "#/definitions/TreeNode",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": {
          "TreeNode": {
            "type": "object",
            "properties": {
              "value": { "type": "number" },
              "children": {
                "type": "array",
                "items": { "$ref": "#/definitions/TreeNode" },
              },
            },
            "required": ["value", "children"],
          },
        },
      });
    });

    it("should handle recursive types with proper $ref", () => {
      const code = `
        interface LinkedList {
          value: number;
          next?: LinkedList;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "LinkedList");

      const schema = typeToJsonSchema(type, checker);

      // Should now generate proper $ref and definitions
      expect(schema).toEqual({
        "$ref": "#/definitions/LinkedList",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": {
          "LinkedList": {
            "type": "object",
            "properties": {
              "value": { "type": "number" },
              "next": { "$ref": "#/definitions/LinkedList" },
            },
            "required": ["value"],
          },
        },
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
              value: { type: "string" },
            },
            required: ["value"],
          },
          b2: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        required: ["b1", "b2"],
      });
    });

    it("should not trigger cycle detection for simple types", () => {
      const code = `
        interface Simple {
          value: number;
          name: string;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "Simple");

      const schema = typeToJsonSchema(type, checker);

      // Simple types should not trigger cycle detection
      expect(schema).toEqual({
        type: "object",
        properties: {
          value: { type: "number" },
          name: { type: "string" },
        },
        required: ["value", "name"],
      });

      // Make sure no $comment about cycles
      expect(JSON.stringify(schema)).not.toContain("Recursive type detected");
    });

    it("should not trigger cycle detection for types with Default wrapper", () => {
      const code = `
        type Default<T, V extends T> = T;
        
        interface Settings {
          theme: Default<string, "dark">;
          fontSize: Default<number, 16>;
        }
      `;
      const { type, checker } = getTypeFromCode(code, "Settings");

      const schema = typeToJsonSchema(type, checker);

      // Check that we get valid schemas (not the cycle detection placeholder)
      expect(schema.properties.theme).toBeDefined();
      expect(schema.properties.fontSize).toBeDefined();

      // Check that theme should be string type with default
      expect(schema.properties.theme.type).toBe("string");
      expect(schema.properties.theme.default).toBe("dark");

      // Check that fontSize should be number type with default
      expect(schema.properties.fontSize.type).toBe("number");
      expect(schema.properties.fontSize.default).toBe(16);

      // Make sure no $comment about cycles
      expect(JSON.stringify(schema)).not.toContain("Recursive type detected");
    });
  });
});

describe("typeToJsonSchema with cycles", () => {
  it("should generate complete schema with $ref and definitions for recursive types", () => {
    const code = `
      interface LinkedList {
        value: number;
        next?: LinkedList;
      }
    `;
    const { type, checker } = getTypeFromCode(code, "LinkedList");

    // This function should do both passes and return proper JSON Schema
    const schema = typeToJsonSchema(type, checker);

    expect(schema).toEqual({
      "$ref": "#/definitions/LinkedList",
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": {
        "LinkedList": {
          "type": "object",
          "properties": {
            "value": { "type": "number" },
            "next": { "$ref": "#/definitions/LinkedList" },
          },
          "required": ["value"],
        },
      },
    });
  });

  it("should return simple schema for non-recursive types", () => {
    const code = `
      interface User {
        name: string;
        age: number;
      }
    `;
    const { type, checker } = getTypeFromCode(code, "User");

    const schema = typeToJsonSchema(type, checker);

    // Non-recursive types should not have $ref or definitions
    expect(schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    });
  });
});

describe("getCycles", () => {
  it("should return empty set for primitive types", () => {
    const { type, checker } = getTypeFromCode(
      "type MyString = string;",
      "MyString",
    );
    const cycles = getCycles(type, checker);
    expect(cycles.size).toBe(0);
  });

  it("should return empty set for simple non-recursive interface", () => {
    const code = `
      interface User {
        name: string;
        age: number;
      }
    `;
    const { type, checker } = getTypeFromCode(code, "User");
    const cycles = getCycles(type, checker);
    expect(cycles.size).toBe(0);
  });

  it("should detect simple recursive type", () => {
    const code = `
      interface LinkedList {
        value: number;
        next?: LinkedList;
      }
    `;
    const { type, checker } = getTypeFromCode(code, "LinkedList");
    const cycles = getCycles(type, checker);
    expect(cycles.size).toBe(1);
    expect(cycles.has(type)).toBe(true);
  });

  it("should detect mutually recursive types", () => {
    const code = `
      interface A {
        b: B;
      }
      interface B {
        a: A;
      }
    `;
    const { type: typeA, checker } = getTypeFromCode(code, "A");
    const { type: typeB } = getTypeFromCode(code, "B");

    const cycles = getCycles(typeA, checker);
    expect(cycles.size).toBe(2);
    // Both A and B should be in the cycles set
  });

  it("should not mark shared non-recursive types as cycles", () => {
    const code = `
      interface Shared {
        value: string;
      }
      interface Parent {
        child1: Shared;
        child2: Shared;
      }
    `;
    const { type, checker } = getTypeFromCode(code, "Parent");
    const cycles = getCycles(type, checker);
    expect(cycles.size).toBe(0);
  });

  it("should handle array of recursive types", () => {
    const code = `
      interface TreeNode {
        value: number;
        children: TreeNode[];
      }
    `;
    const { type, checker } = getTypeFromCode(code, "TreeNode");
    const cycles = getCycles(type, checker);

    // TreeNode should be in cycles because it references itself through children array
    expect(cycles.size).toBeGreaterThan(0);
    // Check if TreeNode is in the cycles
    let hasTreeNode = false;
    cycles.forEach((t) => {
      if (checker.typeToString(t) === "TreeNode") {
        hasTreeNode = true;
      }
    });
    expect(hasTreeNode).toBe(true);
  });

  it("should handle nested recursive types", () => {
    const code = `
      interface Category {
        name: string;
        subcategories: Category[];
        parent?: Category;
      }
    `;
    const { type, checker } = getTypeFromCode(code, "Category");
    const cycles = getCycles(type, checker);
    expect(cycles.size).toBe(1);
    expect(cycles.has(type)).toBe(true);
  });

  it("should not detect cycles in union types without recursion", () => {
    const code = `
      interface A {
        type: "a";
        value: string;
      }
      interface B {
        type: "b";
        value: number;
      }
      type Union = A | B;
    `;
    const { type, checker } = getTypeFromCode(code, "Union");
    const cycles = getCycles(type, checker);
    expect(cycles.size).toBe(0);
  });

  it("should handle types with Default wrapper", () => {
    const code = `
      type Default<T, V extends T> = T;
      interface Settings {
        theme: Default<string, "dark">;
        config: Settings;
      }
    `;
    const { type, checker } = getTypeFromCode(code, "Settings");
    const cycles = getCycles(type, checker);
    expect(cycles.size).toBe(1);
    expect(cycles.has(type)).toBe(true);
  });
});
