import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import {
  ensureTypeNodeRegistered,
  getTypeFromTypeNodeWithFallback,
  hasArrayTypeArgument,
  inferArrayElementType,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  inferWidenedTypeFromExpression,
  isAnyOrUnknownType,
  isAnyType,
  isCollectionType,
  isUnknownType,
  isUnresolvedSchemaType,
  registerLiftAppliedCallType,
  registerSyntheticCallType,
  registerTypeForNode,
  tryExplicitParameterType,
  typeToSchemaTypeNode,
  typeToTypeNode,
  unwrapCellLikeType,
  unwrapOpaqueLikeType,
  widenLiteralType,
} from "../src/ast/type-inference.ts";

interface ProgramParts {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
}

function createProgram(source: string): ProgramParts {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    skipLibCheck: true,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);

  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? sourceFile
      : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.readFile = (name) => name === fileName ? source : baseReadFile(name);
  host.fileExists = (name) => name === fileName || baseFileExists(name);

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function findIdentifier(
  sourceFile: ts.SourceFile,
  text: string,
): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isIdentifier(node) && node.text === text) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing identifier ${text}`);
  return found;
}

function findVariable(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing variable ${name}`);
  return found;
}

function findTypeAlias(
  sourceFile: ts.SourceFile,
  name: string,
): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing type alias ${name}`);
  return found;
}

function findArrow(sourceFile: ts.SourceFile, variableName: string) {
  const variable = findVariable(sourceFile, variableName);
  if (!variable.initializer || !ts.isArrowFunction(variable.initializer)) {
    throw new Error(`Missing arrow initializer for ${variableName}`);
  }
  return variable.initializer;
}

function typeText(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): string {
  return type ? checker.typeToString(type) : "undefined";
}

Deno.test("type inference helpers classify special types and widen literals", () => {
  const { sourceFile, checker } = createProgram(`
    type Generic<T> = T;
    type AnyAlias = any;
    type UnknownAlias = unknown;
    const numberLiteral = 42 as const;
    const stringLiteral = "title" as const;
    const objectValue = { title: "kept" };
  `);
  const anyType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "AnyAlias").type,
  );
  const unknownType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "UnknownAlias").type,
  );
  const typeParameter = checker.getTypeAtLocation(
    findTypeAlias(sourceFile, "Generic").typeParameters![0]!.name,
  );
  const numberType = checker.getTypeAtLocation(
    findIdentifier(sourceFile, "numberLiteral"),
  );
  const stringType = checker.getTypeAtLocation(
    findIdentifier(sourceFile, "stringLiteral"),
  );
  const objectType = checker.getTypeAtLocation(
    findIdentifier(sourceFile, "objectValue"),
  );
  const booleanUnion = (checker as ts.TypeChecker & {
    getUnionType: (types: readonly ts.Type[]) => ts.Type;
  }).getUnionType([
    checker.getTrueType(),
    checker.getFalseType(),
  ]);

  assertEquals(isAnyType(undefined), false);
  assertEquals(isAnyType(anyType), true);
  assertEquals(isUnknownType(undefined), false);
  assertEquals(isUnknownType(unknownType), true);
  assertEquals(isAnyOrUnknownType(undefined), false);
  assertEquals(isAnyOrUnknownType(anyType), true);
  assertEquals(isUnresolvedSchemaType(undefined), false);
  assertEquals(isUnresolvedSchemaType(typeParameter), true);
  assertEquals(
    typeText(widenLiteralType(numberType, checker), checker),
    "number",
  );
  assertEquals(
    typeText(widenLiteralType(stringType, checker), checker),
    "string",
  );
  assertEquals(widenLiteralType(booleanUnion, checker), booleanUnion);
  assertEquals(widenLiteralType(objectType, checker), objectType);
});

Deno.test("type inference helpers infer parameters, returns, and contextual types", () => {
  const { sourceFile, checker } = createProgram(`
    const typed = (value: { title: string }) => value.title;
    const contextual: (value: { count: number }) => number = (value) => value.count;
    type Fn = (item: { count: number }) => number;
    declare const declared: Fn;
    const literal = 1 as const;
  `);
  const typed = findArrow(sourceFile, "typed");
  const contextual = findArrow(sourceFile, "contextual");
  const declared = findVariable(sourceFile, "declared");
  const typedSignature = checker.getSignatureFromDeclaration(typed)!;
  const declaredSignature = checker.getSignaturesOfType(
    checker.getTypeAtLocation(declared.name),
    ts.SignatureKind.Call,
  )[0]!;
  const registry = new WeakMap<ts.Node, ts.Type>();

  const explicit = tryExplicitParameterType(
    typed.parameters[0],
    checker,
    registry,
  );
  assert(explicit);
  assertEquals(
    getTypeFromTypeNodeWithFallback(explicit.typeNode, checker, registry),
    explicit.type,
  );
  assertStringIncludes(typeText(explicit.type, checker), "title");

  const inferredFromSignature = inferParameterType(
    undefined,
    declaredSignature,
    checker,
  );
  assertStringIncludes(typeText(inferredFromSignature, checker), "count");
  assertEquals(
    inferParameterType(typed.parameters[0], typedSignature, checker),
    explicit.type,
  );
  assertEquals(
    typeText(inferReturnType(typed, typedSignature, checker), checker),
    "string",
  );
  assertStringIncludes(
    typeText(inferContextualType(contextual, checker), checker),
    "count",
  );
  assertEquals(
    typeText(
      inferWidenedTypeFromExpression(
        findVariable(sourceFile, "literal").initializer!,
        checker,
      ),
      checker,
    ),
    "number",
  );
});

Deno.test("type inference helpers register synthetic type nodes", () => {
  const { sourceFile, checker } = createProgram(`
    type Name = string;
    type Count = number;
    type Existing = { done: boolean };
    declare function lift(): unknown;
  `);
  const nameNode = findTypeAlias(sourceFile, "Name").type;
  const countNode = findTypeAlias(sourceFile, "Count").type;
  const existingNode = findTypeAlias(sourceFile, "Existing").type;
  const registry = new WeakMap<ts.Node, ts.Type>();
  const typeLiteral = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      "name",
      undefined,
      nameNode,
    ),
    ts.factory.createPropertySignature(
      undefined,
      "count",
      ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      countNode,
    ),
  ]);
  const arrayNode = ts.factory.createArrayTypeNode(nameNode);
  const unionNode = ts.factory.createUnionTypeNode([nameNode, countNode]);
  const parenthesizedNode = ts.factory.createParenthesizedType(nameNode);

  assertEquals(
    ensureTypeNodeRegistered(nameNode, checker),
    checker.getStringType(),
  );
  assertEquals(
    getTypeFromTypeNodeWithFallback(existingNode, checker, registry),
    ensureTypeNodeRegistered(existingNode, checker, registry),
  );
  assertStringIncludes(
    typeText(ensureTypeNodeRegistered(typeLiteral, checker, registry), checker),
    "name",
  );
  assertStringIncludes(
    typeText(ensureTypeNodeRegistered(arrayNode, checker, registry), checker),
    "string[]",
  );
  assertStringIncludes(
    typeText(ensureTypeNodeRegistered(unionNode, checker, registry), checker),
    "string | number",
  );
  assertEquals(
    ensureTypeNodeRegistered(parenthesizedNode, checker, registry),
    checker.getStringType(),
  );

  const returnedNode = registerTypeForNode(
    countNode,
    checker.getNumberType(),
    registry,
  );
  assertEquals(returnedNode, countNode);
  assertEquals(registry.get(countNode), checker.getNumberType());

  const call = ts.factory.createCallExpression(
    findIdentifier(sourceFile, "lift"),
    undefined,
    [],
  );
  registerSyntheticCallType(call, checker.getBooleanType(), registry);
  assertEquals(registry.get(call), checker.getBooleanType());
  const secondCall = ts.factory.createCallExpression(
    findIdentifier(sourceFile, "lift"),
    undefined,
    [],
  );
  registerLiftAppliedCallType(
    secondCall,
    nameNode,
    undefined,
    checker,
    registry,
  );
  assertEquals(registry.get(secondCall), checker.getStringType());
});

Deno.test("type inference helpers detect collections and array element types", () => {
  const { sourceFile, checker } = createProgram(`
    type ArrayContainer = Array<string[]>;
    type UnionContainer = Array<string[]> | Array<number>;
    type IntersectionContainer = Array<string[]> & { tag: string };
    const numbers = [1, 2, 3];
    const tuple = ["name", 1] as const;
    const unionArray = Math.random() > 0.5 ? ["a"] : [1];
    const scalar = 1;
    declare const arrayContainer: ArrayContainer;
    declare const scalarContainer: Array<string>;
  `);
  const numbers = findIdentifier(sourceFile, "numbers");
  const tuple = findIdentifier(sourceFile, "tuple");
  const unionArray = findIdentifier(sourceFile, "unionArray");
  const scalar = findIdentifier(sourceFile, "scalar");
  const arrayContainer = findIdentifier(sourceFile, "arrayContainer");
  const scalarContainer = findIdentifier(sourceFile, "scalarContainer");
  const arrayContainerType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "ArrayContainer").type,
  );
  const unionContainerType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "UnionContainer").type,
  );
  const intersectionContainerType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "IntersectionContainer").type,
  );

  assertEquals(isCollectionType(undefined, checker), false);
  assertEquals(
    isCollectionType(checker.getTypeAtLocation(numbers), checker),
    true,
  );
  assertEquals(
    isCollectionType(checker.getTypeAtLocation(tuple), checker),
    true,
  );
  assertEquals(
    isCollectionType(checker.getTypeAtLocation(unionArray), checker),
    true,
  );
  assertEquals(hasArrayTypeArgument(arrayContainerType, checker), true);
  assertEquals(hasArrayTypeArgument(unionContainerType, checker), true);
  assertEquals(hasArrayTypeArgument(intersectionContainerType, checker), true);
  assertEquals(
    hasArrayTypeArgument(checker.getTypeAtLocation(scalarContainer), checker),
    false,
  );

  assertEquals(
    typeText(
      inferArrayElementType(numbers, {
        checker,
        factory: ts.factory,
        sourceFile,
      }).type,
      checker,
    ),
    "number",
  );
  assertEquals(
    typeText(
      inferArrayElementType(arrayContainer, {
        checker,
        factory: ts.factory,
        sourceFile,
      }).type,
      checker,
    ),
    "string",
  );
  assertEquals(
    typeText(
      inferArrayElementType(scalarContainer, {
        checker,
        factory: ts.factory,
        sourceFile,
      }).type,
      checker,
    ),
    "string",
  );
  assertEquals(
    inferArrayElementType(scalar, {
      checker,
      factory: ts.factory,
      sourceFile,
    }).typeNode.kind,
    ts.SyntaxKind.UnknownKeyword,
  );
});

Deno.test("type inference helpers convert and unwrap types conservatively", () => {
  const { sourceFile, checker } = createProgram(`
    type Box<T> = { value: T };
    type NameBox = Box<string>;
    type NameOrCount = string | number;
    const value: NameBox = { value: "Ada" };
  `);
  const boxType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "NameBox").type,
  );
  const unionType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "NameOrCount").type,
  );
  const value = findIdentifier(sourceFile, "value");

  assertStringIncludes(
    typeText(unwrapOpaqueLikeType(unionType, checker), checker),
    "string | number",
  );
  assertEquals(unwrapCellLikeType(undefined, checker), undefined);
  assertEquals(unwrapCellLikeType(boxType, checker), boxType);

  const asTypeNode = typeToTypeNode(boxType, checker, sourceFile);
  assert(asTypeNode);
  assertStringIncludes(
    ts.createPrinter().printNode(
      ts.EmitHint.Unspecified,
      asTypeNode,
      sourceFile,
    ),
    "NameBox",
  );
  const schemaTypeNode = typeToSchemaTypeNode(
    checker.getTypeAtLocation(value),
    checker,
    sourceFile,
  );
  assert(schemaTypeNode);
});
