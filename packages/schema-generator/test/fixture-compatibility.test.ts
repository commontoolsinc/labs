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
      }
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
      foundTypeNode = node.type;
    }
  });

  if (!foundType) {
    throw new Error(`Type ${typeName} not found in code`);
  }

  return foundTypeNode 
    ? { type: foundType, checker, typeNode: foundTypeNode }
    : { type: foundType, checker };
}

describe("Fixture Compatibility", () => {
  it("should generate compatible schema for TodoItem interface", () => {
    const transformer = createSchemaTransformerV2();

    const code = `
      interface TodoItem {
        title: string;
        done: boolean;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "TodoItem");
    const schema = transformer(type, checker);

    // Verify the schema structure matches the expected output
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.title).toEqual({ type: "string" });
    expect(schema.properties?.done).toEqual({ type: "boolean" });
    expect(schema.required).toEqual(["title", "done"]);
  });

  it("should generate compatible schema for array of TodoItem", () => {
    const transformer = createSchemaTransformerV2();

    const code = `
      interface TodoItem {
        title: string;
        done: boolean;
      }
      
      type TodoList = TodoItem[];
    `;

    const { type, checker, typeNode } = getTypeFromCode(code, "TodoList");
    const schema = transformer(type, checker, typeNode);

    // Expect correct array detection with object items
    expect(schema.type).toBe("array");
    expect(schema.items?.type).toBe("object");
    expect(schema.items?.properties?.title?.type).toBe("string");
    expect(schema.items?.properties?.done?.type).toBe("boolean");
  });

  it("should generate compatible schema for root object with items array", () => {
    const transformer = createSchemaTransformerV2();

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
    const schema = transformer(type, checker);

    // Verify the schema structure matches the expected output
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    const items = schema.properties?.items as Record<string, any>;
    expect(items).toBeDefined();
    expect(items.type).toBe("array");
    expect(items.items?.type).toBe("object");
    expect(items.items?.properties?.title?.type).toBe("string");
    expect(items.items?.properties?.done?.type).toBe("boolean");
    expect(schema.required).toEqual(["items"]);
  });
});
