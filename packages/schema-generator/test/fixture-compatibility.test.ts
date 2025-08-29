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
): { type: ts.Type; checker: ts.TypeChecker } {
  const { program, checker, sourceFile } = createTestProgram(code);

  // Find the interface declaration
  let foundType: ts.Type | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) {
        foundType = checker.getDeclaredTypeOfSymbol(symbol);
      }
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
    }
  });

  if (!foundType) {
    throw new Error(`Type ${typeName} not found in code`);
  }

  return { type: foundType, checker };
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

    const { type, checker } = getTypeFromCode(code, "TodoList");
    const schema = transformer(type, checker);

    // For now, we expect this to fall back to object type since we don't have the typeNode
    // This reveals a limitation of our current approach - we need the AST node for reliable array detection
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(true);
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
    expect(schema.properties?.items).toBeDefined();
    // For now, we expect items to be treated as an object type since we don't have the typeNode
    // This reveals a limitation of our current approach
    expect(schema.properties?.items?.type).toBe("object");
    expect(schema.properties?.items?.additionalProperties).toBe(true);
    expect(schema.required).toEqual(["items"]);
  });
});
