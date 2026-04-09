import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";
import {
  CommonFabricTransformerPipeline,
  transformCfDirective,
} from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformSource } from "./utils.ts";

function createProgram(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
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
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error("Missing source file for UI helper test");
  }

  return { program, sourceFile };
}

Deno.test(
  "UI helpers lower to intrinsic tags and emit data-ui markers",
  async () => {
    const source = `/// <cts-enable />
      import { UiAction, UiDisclosure, UiPromptSlot } from "commonfabric";

      export default () => (
        <div>
          <UiAction action="SubmitDirectCommand" onClick={() => null}>Go</UiAction>
          <UiPromptSlot surface="PromptPane" role="assistant" />
          <UiDisclosure kind="warning">Heads up</UiDisclosure>
        </div>
      );
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(
      output,
      '<ct-button data-ui-action="SubmitDirectCommand"',
    );
    assertStringIncludes(
      output,
      '<ct-textarea data-ui-surface="PromptPane" data-ui-role="assistant"',
    );
    assertStringIncludes(
      output,
      '<ct-card data-ui-disclosure-kind="warning">Heads up</ct-card>',
    );
    assertEquals(output.includes("<UiAction"), false);
  },
);

Deno.test(
  "UI helper literal props seed cfcUiContract hints but dynamic props do not",
  () => {
    const source = `/// <cts-enable />
      import { UiAction } from "commonfabric";

      const dynamicAction = "SubmitDirectCommand";

      export default () => (
        <div>
          <UiAction action="SubmitDirectCommand" />
          <UiAction action={dynamicAction} />
        </div>
      );
    `;

    const { program, sourceFile } = createProgram(source);
    const schemaHints = new WeakMap<ts.Node, { cfcUiContract?: unknown }>();
    const pipeline = new CommonFabricTransformerPipeline({
      schemaHints: schemaHints as WeakMap<ts.Node, never>,
    });

    const result = ts.transform(sourceFile, pipeline.toFactories(program));
    const transformedFile = result.transformed[0];
    assert(transformedFile, "Expected transformed source file");

    const helperNodes = [] as Array<ts.JsxElement | ts.JsxSelfClosingElement>;
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
        (
          (ts.isJsxElement(node) &&
            ts.isIdentifier(node.openingElement.tagName) &&
            node.openingElement.tagName.text === "ct-button") ||
          (ts.isJsxSelfClosingElement(node) &&
            ts.isIdentifier(node.tagName) &&
            node.tagName.text === "ct-button")
        )
      ) {
        helperNodes.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(transformedFile);

    assertEquals(helperNodes.length, 2);
    const literalHint = schemaHints.get(helperNodes[0] as ts.Node);
    const dynamicHint = schemaHints.get(helperNodes[1] as ts.Node);

    assertEquals(
      literalHint,
      {
        cfcUiContract: {
          helper: "UiAction",
          action: "SubmitDirectCommand",
        },
      },
    );
    assertEquals(dynamicHint, undefined);

    result.dispose?.();
  },
);

Deno.test(
  "UI helper contract hints propagate onto generated schemas",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, UI, UiAction } from "commonfabric";

      export default pattern<{ title: string }>((state) => ({
        [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
        title: state.title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "uiContract");
    assertStringIncludes(output, "SubmitDirectCommand");
  },
);

Deno.test(
  "UI helper contract hints also reach explicit output schemas",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, UI, UiAction } from "commonfabric";

      type Model = { title: string };

      export default pattern<Model, Model>((state) => ({
        [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
        title: state.title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "uiContract");
    assertStringIncludes(output, "SubmitDirectCommand");
  },
);
