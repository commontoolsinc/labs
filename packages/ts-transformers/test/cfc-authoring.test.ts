import { assertEquals } from "@std/assert";
import ts from "typescript";
import { transformCfDirective } from "../src/mod.ts";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { CFC_CANONICAL_ALIAS_NAMES } from "../src/cfc-authoring.ts";
import { CrossStageState, SchemaInjectionTransformer } from "../src/mod.ts";

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
          (
            node.initializer.expression.name.text === "__ct_data" ||
            node.initializer.expression.name.text === "__cf_data"
          ) &&
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
    state: new CrossStageState(),
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
    "Confidential",
    "Integrity",
    "AddIntegrity",
    "RepresentsCurrentUser",
    "AuthoredByCurrentUser",
    "RequiresIntegrity",
    "MaxConfidentiality",
    "WriteAuthorizedBy",
    "TrustedActionWriteWithIntegrity",
    "TrustedActionWrite",
    "TrustedActionUiContract",
    "ExactCopy",
    "ProjectionPath",
    "ProjectionOf",
    "Projection",
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
  "WriteAuthorizedBy lowers trusted top-level builder bindings with statement-form identity annotation",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: WriteAuthorizedBy<string, typeof saveTitle>;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("const saveTitle = __cfBindVerifiedBinding("),
      false,
    );
    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      true,
    );
  },
);

Deno.test(
  "TrustedActionWrite lowers trusted top-level builder bindings",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, TrustedActionWrite } from "commonfabric";

      const TRUSTED_SAVE_ACTION = "TrustedSaveTitle";
      const TRUSTED_SAVE_SURFACE = "TrustedSaveSurface";

      const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: TrustedActionWrite<
          string,
          typeof saveTitle,
          typeof TRUSTED_SAVE_ACTION,
          typeof TRUSTED_SAVE_SURFACE
        >;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      true,
    );
    assertEquals(
      output.includes('action: "TrustedSaveTitle"'),
      true,
    );
    assertEquals(
      output.includes('trustedPattern: "TrustedSaveSurface"'),
      true,
    );
    assertEquals(
      output.includes('requiredEventIntegrity: ["TrustedSaveSurface"]'),
      true,
    );
  },
);

Deno.test(
  "WriteAuthorizedBy lowers alias-referenced trusted builder bindings",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      type TrustedWrite<T, Binding> = WriteAuthorizedBy<T, Binding>;

      const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: TrustedWrite<string, typeof saveTitle>;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      true,
    );
  },
);

Deno.test(
  "WriteAuthorizedBy lowers exported trusted builder bindings inline",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      export const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: WriteAuthorizedBy<string, typeof saveTitle>;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("export const saveTitle = __cfBindVerifiedBinding("),
      true,
    );
    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      false,
    );
  },
);

Deno.test(
  "WriteAuthorizedBy accepts direct supported builder binding initializers",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      declare function module<T>(fn: T): T;
      declare function requireEventIntegrity<T>(fn: T): T;

      const moduleWriter = module(() => undefined);
      const eventWriter = requireEventIntegrity(() => undefined);

      const moduleSchema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof moduleWriter>
      >();
      const eventSchema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof eventWriter>
      >();

      export { moduleSchema, eventSchema };
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
  },
);

Deno.test(
  "WriteAuthorizedBy validates concrete pattern output schemas",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      interface InvalidQueryOutput {
        savedTitle: WriteAuthorizedBy<string, string>;
      }

      interface InvalidBindingOutput {
        savedTitle: WriteAuthorizedBy<string, typeof arbitrary>;
      }

      const invalidQuery = pattern<{ title: string }, InvalidQueryOutput>(
        (state) => ({ savedTitle: state.title }),
      );
      const invalidBinding = pattern<{ title: string }, InvalidBindingOutput>(
        (state) => ({ savedTitle: state.title }),
      );

      export { invalidQuery, invalidBinding };
    `;

    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const cfcDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    );

    assertEquals(cfcDiagnostics.length >= 2, true);
  },
);

Deno.test(
  "WriteAuthorizedBy validates concrete alias chains without rejecting unused generic aliases",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      type TrustedWrite<T, Binding> = WriteAuthorizedBy<T, Binding>;

      const saveTitle = handler<void, { title: { get(): string; savedTitle: { set(value: string): void } } }>(
        () => undefined,
      );

      interface Output {
        savedTitle: TrustedWrite<string, typeof saveTitle>;
      }

      const valid = pattern<{ title: string }, Output>(
        (state) => ({ savedTitle: state.title }),
      );

      export { valid };
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
        { confidentiality: "public" }
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
    const arbitrary = 123;
    const invalidSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof missingInitializer>
    >();
    const invalidBindingSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof arbitrary>
    >();

    const invalidQuerySchema = toSchema<
      WriteAuthorizedBy<{ title: string }, string>
    >();

    export { invalidSchema, invalidBindingSchema, invalidQuerySchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ).length >= 3,
    true,
  );
});
