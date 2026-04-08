import { assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import type { CapabilityParamSummary } from "../src/core/mod.ts";
import {
  applyShrinkAndWrap,
  printTypeNode,
} from "../src/transformers/type-shrinking.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function createProgramWithFiles(
  files: Record<string, string>,
  entryFileName = "/test.ts",
): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(
          name,
          files[name]!,
          languageVersion,
          true,
          name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) => {
        const directMatch = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` ||
          fileName.endsWith(`/${name}.d.ts`)
        );
        if (!directMatch) {
          return undefined;
        }
        return {
          resolvedFileName: directMatch,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }),
  };

  const program = ts.createProgram([entryFileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(entryFileName);
  if (!sourceFile) {
    throw new Error("Expected source file in program.");
  }

  return { sourceFile, checker: program.getTypeChecker() };
}

function findTypeAlias(
  sourceFile: ts.SourceFile,
  aliasName: string,
): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === aliasName
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Type alias ${aliasName} not found`);
  }

  return found;
}

function createParamSummary(
  summary: Partial<CapabilityParamSummary>,
): CapabilityParamSummary {
  return {
    name: "input",
    capability: "opaque",
    readPaths: [],
    writePaths: [],
    passthrough: false,
    wildcard: false,
    identityOnly: false,
    ...summary,
  };
}

Deno.test("applyShrinkAndWrap preserves tuple roots for length-only synthetic shrinking", () => {
  const { sourceFile, checker } = createProgram(`
    type Pair = [number, string];
  `);
  const alias = findTypeAlias(sourceFile, "Pair");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "Pair");
});

Deno.test("applyShrinkAndWrap does not treat numeric index signatures as arrays", () => {
  const { sourceFile, checker } = createProgram(`
    type Indexed = { [index: number]: string };
  `);
  const alias = findTypeAlias(sourceFile, "Indexed");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

Deno.test("applyShrinkAndWrap preserves full array item shapes for direct array reads", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      people: {
        active: boolean;
        name: string;
        priorityRank: number;
      }[];
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["people"], ["people", "0", "active"]],
      fullShapePaths: [["people"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  assertStringIncludes(printed, "people");
  assertStringIncludes(printed, "active");
  assertStringIncludes(printed, "name");
  assertStringIncludes(printed, "priorityRank");
  assertEquals(printed.includes("other"), false);
});

Deno.test("applyShrinkAndWrap defaults-only fallback expands repeated child leaves independently", () => {
  const { sourceFile, checker } = createProgram(`
    type Shared = { a: string; b: string };
    type Input = { group: { left: Shared; right: Shared } };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      defaults: [{
        path: ["group", "left", "a"],
        defaultType: ts.factory.createKeywordTypeNode(
          ts.SyntaxKind.StringKeyword,
        ),
      }],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "defaults_only",
  );

  const printed = printTypeNode(result, sourceFile);
  assertStringIncludes(printed, "right: {\n            a: string;");
  assertStringIncludes(printed, "\n            b: string;");
  assertEquals(printed.includes("right: Shared"), false);
});

Deno.test("applyShrinkAndWrap preserves nested primitive leaves for property-only access", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = { text: string };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["text", "length"]],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  assertStringIncludes(printed, "text: string;");
  assertEquals(printed.includes("length: number"), false);
});

Deno.test("applyShrinkAndWrap turns identity-only wrapped inputs into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    alias.type,
    baseType,
    true,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    "__cfHelpers.OpaqueCell<unknown>",
  );
});

Deno.test("applyShrinkAndWrap turns identity-only unwrapped inputs into unknown", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

Deno.test("applyShrinkAndWrap turns identity-only cell leaves into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      left: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
      right: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["left"], ["right"]],
      identityCellPaths: [["left"], ["right"]],
    }),
    ts.factory.createTypeReferenceNode("Input"),
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  assertStringIncludes(printed, "left: __cfHelpers.OpaqueCell<unknown>");
  assertStringIncludes(printed, "right: __cfHelpers.OpaqueCell<unknown>");
  assertEquals(printed.includes("name"), false);
  assertEquals(printed.includes("nested"), false);
});

Deno.test("applyShrinkAndWrap shrinks direct array parameters to used item fields", () => {
  const { sourceFile, checker } = createProgram(`
    type AssetRecord = {
      id: string;
      stage: string;
      owner: string;
      unused: { nested: string };
    };
    type Input = AssetRecord[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["id"], ["stage"], ["owner"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  assertStringIncludes(printed, "id: string;");
  assertStringIncludes(printed, "stage: string;");
  assertStringIncludes(printed, "owner: string;");
  assertEquals(printed.includes("unused"), false);
  assertEquals(printed.includes("nested"), false);
});

Deno.test("applyShrinkAndWrap preserves inherited interface fields in array unions", () => {
  const { sourceFile, checker } = createProgram(`
    interface LeadState {
      id: string;
      name: string;
    }

    interface LeadScoreSummary extends LeadState {
      score: number;
      unused: string;
    }

    type Input = LeadScoreSummary[] | undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "id"], ["0", "score"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  assertStringIncludes(printed, "id: string;");
  assertStringIncludes(printed, "score: number;");
  assertEquals(printed.includes("name"), false);
  assertEquals(printed.includes("unused"), false);
});

Deno.test("applyShrinkAndWrap preserves aliased fixed-symbol keys in node-driven shrinking", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/test.ts": `
      import { SELF as CF_SELF } from "commonfabric";

      type Input = {
        [CF_SELF]?: { id: string; title: string };
        value: string;
      };
    `,
    "/commonfabric.d.ts": `
      export declare const SELF: unique symbol;
    `,
  });
  const alias = findTypeAlias(sourceFile, "Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["$SELF", "id"]],
    }),
    alias.type,
    undefined,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  assertStringIncludes(printed, "[CF_SELF]?: {");
  assertStringIncludes(printed, "id: string;");
  assertEquals(printed.includes("title"), false);
  assertEquals(printed.includes("value"), false);
});
