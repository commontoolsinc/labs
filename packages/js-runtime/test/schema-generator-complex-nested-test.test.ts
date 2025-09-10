import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "@commontools/schema-generator";
import { describe, it } from "@std/testing/bdd";

/**
 * Test our new schema generator against the complex-nested-types fixture
 * This will reveal gaps in our formatter coverage and show us what to build next
 */
describe("Schema Generator Complex Nested Types Test", () => {
  it("should generate correct schema for UserEvent interface", () => {
    const code = `
      interface UserEvent {
        user: {
          name: string;
          email: string;
          age?: number;
        };
        action: "create" | "update" | "delete";
      }
    `;

    const { type, checker } = getTypeFromCode(code, "UserEvent");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Should be an object with user and action properties
    expect(result.type).toBe("object");
    expect(result.properties).toBeDefined();
    expect(result.properties?.user).toBeDefined();
    expect(result.properties?.action).toBeDefined();

    // User should be an object with name, email, age properties
    const userProp = result.properties?.user;
    expect(userProp?.type).toBe("object");
    expect(userProp?.properties?.name?.type).toBe("string");
    expect(userProp?.properties?.email?.type).toBe("string");
    expect(userProp?.properties?.age?.type).toBe("number");

    // age should be optional (not in required array)
    expect(userProp?.required).toContain("name");
    expect(userProp?.required).toContain("email");
    expect(userProp?.required).not.toContain("age");

    // Action should be a union type handled by UnionFormatter
    const actionProp = result.properties?.action;
    expect(actionProp?.enum).toEqual(["create", "update", "delete"]);
  });

  it("should generate correct schema for UserState interface", () => {
    const code = `
      // Mock Cell type for testing - use interface to create proper TypeReference
      interface Cell<T> {
        get(): T;
        set(value: T): void;
      }
      
      interface UserState {
        lastAction: Cell<string>;
        count: Cell<number>;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "UserState");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Remove debug logging since tests should be clean

    // Should be an object with lastAction, count properties
    expect(result.type).toBe("object");
    expect(result.properties).toBeDefined();
    expect(result.properties?.lastAction).toBeDefined();
    expect(result.properties?.count).toBeDefined();

    // lastAction should be Cell<string>
    const lastActionProp = result.properties?.lastAction;
    expect(lastActionProp?.asCell).toBe(true);
    expect(lastActionProp?.type).toBe("string");

    // count should be Cell<number>
    const countProp = result.properties?.count;
    expect(countProp?.asCell).toBe(true);
    expect(countProp?.type).toBe("number");

    // All properties should be required
    expect(result.required).toContain("lastAction");
    expect(result.required).toContain("count");
  });

  it("should handle nested generic types correctly", () => {
    const code = `
      // Mock Cell type for testing - use interface to create proper TypeReference
      interface Cell<T> {
        get(): T;
        set(value: T): void;
      }
      
      // Define the array type separately to ensure it's preserved
      type DataArray = Array<{
        id: string;
        value: number;
      }>;
      
      interface NestedGeneric {
        data: Cell<DataArray>;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "NestedGeneric");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Should handle nested Cell<Array<object>> correctly
    const dataProp = result.properties?.data;
    expect(dataProp?.asCell).toBe(true);
    expect(dataProp?.type).toBe("array");
    expect(dataProp?.items?.type).toBe("object");
    expect(dataProp?.items?.properties?.id?.type).toBe("string");
    expect(dataProp?.items?.properties?.value?.type).toBe("number");
  });

  it("should handle union types in properties", () => {
    const code = `
      interface UnionTest {
        status: "active" | "inactive" | "pending";
        priority: 1 | 2 | 3;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "UnionTest");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Union types should be handled correctly by UnionFormatter
    const statusProp = result.properties?.status;
    const priorityProp = result.properties?.priority;

    // Status should be a string enum
    expect(statusProp?.enum).toEqual(["active", "inactive", "pending"]);

    // Priority should be a number enum
    expect(priorityProp?.enum).toEqual([1, 2, 3]);
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
