import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "@commontools/schema-generator";
import { describe, it } from "@std/testing/bdd";

/**
 * Test our new schema generator against the simple-handler fixture
 * This will help us validate that our system can handle real-world TypeScript code
 */
describe("Schema Generator Fixture Test", () => {
  it("should generate correct schema for CounterEvent interface", () => {
    const code = `
      interface CounterEvent {
        increment: number;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "CounterEvent");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Expected structure based on simple-handler.expected.ts
    const expected = {
      type: "object",
      properties: {
        increment: {
          type: "number",
        },
      },
      required: ["increment"],
    };

    expect(result).toEqual(expected);
  });

  it("should generate correct schema for CounterState interface", () => {
    const code = `
      interface CounterState {
        value: number;
      }
    `;

    const { type, checker } = getTypeFromCode(code, "CounterState");
    const generator = createSchemaTransformerV2();

    const result = generator(type, checker);

    // Expected structure based on simple-handler.expected.ts
    const expected = {
      type: "object",
      properties: {
        value: {
          type: "number",
        },
      },
      required: ["value"],
    };

    expect(result).toEqual(expected);
  });

  it("should handle the complete handler signature types", () => {
    const code = `
      import { handler } from "commontools";

      interface CounterEvent {
        increment: number;
      }

      interface CounterState {
        value: number;
      }

      const myHandler = handler<CounterEvent, CounterState>((event, state) => {
        state.value = state.value + event.increment;
      });
    `;

    // Test both types that would be used in the handler signature
    const eventType = getTypeFromCode(code, "CounterEvent");
    const stateType = getTypeFromCode(code, "CounterState");

    const generator = createSchemaTransformerV2();

    const eventSchema = generator(eventType.type, eventType.checker);
    const stateSchema = generator(stateType.type, stateType.checker);

    // Both should be valid object schemas
    expect(eventSchema.type).toBe("object");
    expect(stateSchema.type).toBe("object");
    expect(eventSchema.properties?.increment?.type).toBe("number");
    expect(stateSchema.properties?.value?.type).toBe("number");
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
