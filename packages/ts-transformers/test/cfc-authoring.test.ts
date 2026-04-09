import { assertEquals } from "@std/assert";
import ts from "typescript";
import { transformCfDirective } from "../src/mod.ts";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { CFC_CANONICAL_ALIAS_NAMES } from "../src/cfc-authoring.ts";
import { SchemaInjectionTransformer } from "../src/mod.ts";

function normalizePrintedNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  const printer = ts.createPrinter({
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  });
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
    .replace(/\s+/g, " ")
    .trim();
}

function extractVariableInitializer(
  output: string,
  variableName: string,
): string {
  const sourceFile = ts.createSourceFile(
    "/output.tsx",
    output,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let initializer: string | undefined;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      const unwrapped = ts.isCallExpression(node.initializer) &&
          ts.isPropertyAccessExpression(node.initializer.expression) &&
          ts.isIdentifier(node.initializer.expression.expression) &&
          node.initializer.expression.expression.text === "__cfHelpers" &&
          node.initializer.expression.name.text === "__ct_data" &&
          node.initializer.arguments[0]
        ? node.initializer.arguments[0]
        : node.initializer;
      initializer = normalizePrintedNode(unwrapped, sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!initializer) {
    throw new Error(`Missing variable initializer for ${variableName}`);
  }

  return initializer;
}

function extractPatternSchemaPairs(output: string): string[][] {
  const sourceFile = ts.createSourceFile(
    "/output.tsx",
    output,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const pairs: string[][] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "pattern" &&
      node.arguments.length >= 3
    ) {
      pairs.push([
        normalizePrintedNode(node.arguments[1]!, sourceFile),
        normalizePrintedNode(node.arguments[2]!, sourceFile),
      ]);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return pairs;
}

function transformWithSchemaInjection(source: string): string {
  const fileName = "/test.tsx";
  const transformedSource = transformCfDirective(source);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    jsxFragmentFactory: "__ctHelpers.h.fragment",
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictBindCallApply: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const rootFiles = [fileName, ...Object.keys(COMMONFABRIC_TYPES)];
  const sourceFiles = new Map<string, string>([
    [fileName, transformedSource],
    ...Object.entries(COMMONFABRIC_TYPES),
  ]);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    name,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const sourceText = sourceFiles.get(name);
    if (sourceText !== undefined) {
      return ts.createSourceFile(name, sourceText, languageVersion, true);
    }
    return originalGetSourceFile(
      name,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (name) => sourceFiles.get(name) ?? originalReadFile(name);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sourceFiles.has(name) || originalFileExists(name);
  host.resolveModuleNames = (moduleNames) =>
    moduleNames.map((name) => {
      if (name === "commonfabric") {
        return {
          resolvedFileName: "commonfabric.d.ts",
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }
      return undefined;
    });

  const program = ts.createProgram(rootFiles, compilerOptions, host);
  const transformer = new SchemaInjectionTransformer({
    mode: "transform",
    typeRegistry: new WeakMap(),
  });
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error("Missing source file for schema injection test");
  }

  const result = ts.transform(sourceFile, [transformer.toFactory(program)]);
  const printer = ts.createPrinter({
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  });
  const output = printer.printFile(result.transformed[0]!);
  result.dispose?.();
  return output;
}

Deno.test("ts-transformers re-exports the canonical CFC alias set", () => {
  assertEquals(CFC_CANONICAL_ALIAS_NAMES, [
    "Cfc",
    "Classified",
    "Integrity",
    "AddIntegrity",
    "RequiresIntegrity",
    "MaxConfidentiality",
    "OpaqueInput",
    "WriteAuthorizedBy",
    "ExactCopy",
    "ProjectionPath",
    "ProjectionOf",
    "Projection",
    "LengthPreservedFrom",
    "FilteredFrom",
    "SubsetOf",
    "PermutationOf",
  ]);
});

Deno.test("WriteAuthorizedBy accepts a local function binding", async () => {
  const source = `/// <cts-enable />
    import { toSchema, WriteAuthorizedBy } from "commonfabric";

    function localFunction() {}

    const functionSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof localFunction>
    >();

    export { functionSchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ),
    false,
  );
});

Deno.test(
  "WriteAuthorizedBy preserves the local binding identity through schema emission",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      function localFunction() {}

      const functionSchema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof localFunction>
      >();

      export { functionSchema };
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(output.includes("__ctWriterIdentityOf: {"), true);
    assertEquals(output.includes('file: "/test.tsx"'), true);
    assertEquals(output.includes('path: ["localFunction"]'), true);
  },
);

Deno.test(
  "Schema injection keeps explicit and inferred CFC-aware pattern schemas aligned",
  async () => {
    const source = `/// <cts-enable />
      import { pattern } from "commonfabric";
      import type { Cfc } from "commonfabric";

      type Model = Cfc<
        { title: string },
        { classification: "public" }
      >;

      const explicit = pattern<Model, Model>((cell) => ({ title: cell.title }));
      const inferred = pattern((cell: Model) => ({ title: cell.title }));
    `;

    const output = await transformWithSchemaInjection(source);
    const pairs = extractPatternSchemaPairs(output);
    assertEquals(pairs.length, 2);
    assertEquals(pairs[0]![0], pairs[1]![0]);
  },
);

Deno.test(
  "Schema injection keeps inferred schemas, explicit toSchema<T>(), and explicit output bindings identical",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, toSchema } from "commonfabric";

      interface Model {
        title: string;
      }

      const directSchema = toSchema<Model>();
      const inferred = pattern((state: Model) => ({ title: state.title }));
      const explicit = pattern<Model, Model>((state) => ({ title: state.title }));

      export { directSchema, inferred, explicit };
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const directSchema = extractVariableInitializer(output, "directSchema");
    const pairs = extractPatternSchemaPairs(output);

    assertEquals(pairs.length, 2);
    assertEquals(pairs[0]![1], pairs[1]![1]);
    assertEquals(directSchema, pairs[0]![1]);
    assertEquals(directSchema, pairs[1]![1]);
  },
);

Deno.test("WriteAuthorizedBy rejects unsupported binding declarations", async () => {
  const source = `/// <cts-enable />
    import { toSchema, WriteAuthorizedBy } from "commonfabric";

    declare const missingInitializer: () => void;
    const invalidSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof missingInitializer>
    >();

    const invalidQuerySchema = toSchema<
      WriteAuthorizedBy<{ title: string }, string>
    >();

    export { invalidSchema, invalidQuerySchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ),
    true,
  );
});
