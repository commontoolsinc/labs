import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "@commontools/schema-generator";
import { describe, it } from "@std/testing/bdd";

/**
 * Test our new schema generator against the opaque-ref-map fixture
 * This will validate our array handling and nested object resolution
 */
describe("Schema Generator OpaqueRef Test", () => {
  it("should generate correct schema for TodoItem interface", () => {
    const code = `
      interface TodoItem {
        title: string;
        done: boolean;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "TodoItem");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Expected structure based on opaque-ref-map.expected.ts
    const expected = {
      type: "object",
      properties: {
        title: {
          type: "string",
        },
        done: {
          type: "boolean",
        },
      },
      required: ["title", "done"],
    };

    console.log("TodoItem schema result:", JSON.stringify(result, null, 2));
    expect(result).toEqual(expected);
  });

  it("should generate correct schema for TodoItem[] array", () => {
    const code = `
      interface TodoItem {
        title: string;
        done: boolean;
      }
      
      type TodoList = TodoItem[];
    `;

    const { type, checker, typeNode } = getTypeFromCode(code, "TodoList");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker, typeNode);

    // Expected structure - array with TodoItem schema as items
    const expected = {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
          },
          done: {
            type: "boolean",
          },
        },
        required: ["title", "done"],
      },
    };

    console.log("TodoItem[] schema result:", JSON.stringify(result, null, 2));
    expect(result).toEqual(expected);
  });

  it("should generate correct schema for root object with TodoItem[] property", () => {
    const code = `
      interface TodoItem {
        title: string;
        done: boolean;
      }
      
      interface RootObject {
        items: TodoItem[];
      }
    `;

    const { type, checker } = getTypeFromCode(code, "RootObject");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Expected structure - root object with items array property
    const expected = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
              },
              done: {
                type: "boolean",
              },
            },
            required: ["title", "done"],
          },
        },
      },
      required: ["items"],
    };

    console.log(
      "Root object with TodoItem[] schema result:",
      JSON.stringify(result, null, 2),
    );
    expect(result).toEqual(expected);
  });

  it("should handle the complete opaque-ref-map fixture structure", () => {
    const code = `
      interface TodoItem {
        title: string;
        done: boolean;
      }
      
      type FixtureType = { items: TodoItem[] };
    `;

    // Test the complete structure that would be used in the recipe
    const { type, checker, typeNode } = getTypeFromCode(code, "FixtureType");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker, typeNode);

    console.log(
      "Complete fixture schema result:",
      JSON.stringify(result, null, 2),
    );

    // Should be an object with items array
    expect(result.type).toBe("object");
    expect(result.properties).toBeDefined();
    expect(result.properties?.items).toBeDefined();

    // Items should be an array
    expect(result.properties?.items?.type).toBe("array");
    expect(result.properties?.items?.items).toBeDefined();

    // Array items should be TodoItem objects
    const arrayItems = result.properties?.items?.items;
    expect(arrayItems?.type).toBe("object");
    expect(arrayItems?.properties?.title?.type).toBe("string");
    expect(arrayItems?.properties?.done?.type).toBe("boolean");
    expect(arrayItems?.required).toContain("title");
    expect(arrayItems?.required).toContain("done");

    // Root should require items
    expect(result.required).toContain("items");
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
