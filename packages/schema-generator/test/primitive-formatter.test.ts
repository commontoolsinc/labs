import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { PrimitiveFormatter } from "../src/formatters/primitive-formatter.ts";
import type { FormatterContext } from "../src/interface.ts";

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

describe("PrimitiveFormatter", () => {
  const formatter = new PrimitiveFormatter();

  // Mock context for testing
  const mockContext: FormatterContext = {
    rootSchema: {},
    seenTypes: new Set(),
    typeChecker: {} as ts.TypeChecker,
    depth: 0,
    maxDepth: 200,
    definitions: {},
    definitionStack: new Set(),
    inProgressNames: new Set(),
    emittedRefs: new Set(),
  };

  describe("supportsType", () => {
    it("should support string types", () => {
      const { type } = getTypeFromCode("type MyString = string;", "MyString");
      expect(formatter.supportsType(type, mockContext)).toBe(true);
    });

    it("should support number types", () => {
      const { type } = getTypeFromCode("type MyNumber = number;", "MyNumber");
      expect(formatter.supportsType(type, mockContext)).toBe(true);
    });

    it("should support boolean types", () => {
      const { type } = getTypeFromCode("type MyBoolean = boolean;", "MyBoolean");
      expect(formatter.supportsType(type, mockContext)).toBe(true);
    });
  });

  describe("formatType", () => {
    it("should format string type", () => {
      const { type } = getTypeFromCode("type MyString = string;", "MyString");
      const schema = formatter.formatType(type, mockContext);
      expect(schema).toEqual({ type: "string" });
    });

    it("should format number type", () => {
      const { type } = getTypeFromCode("type MyNumber = number;", "MyNumber");
      const schema = formatter.formatType(type, mockContext);
      expect(schema).toEqual({ type: "number" });
    });

    it("should format boolean type", () => {
      const { type } = getTypeFromCode("type MyBoolean = boolean;", "MyBoolean");
      const schema = formatter.formatType(type, mockContext);
      expect(schema).toEqual({ type: "boolean" });
    });
  });
});

