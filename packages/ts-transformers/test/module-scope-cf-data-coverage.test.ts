import { assert, assertStringIncludes } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { ModuleScopeCfDataTransformer } from "../src/transformers/module-scope-cf-data.ts";
import { TransformationContext } from "../src/core/mod.ts";

// The module-scope cf-data transformer wraps top-level data expressions with a
// `__cf_data` helper call. The existing `module-scope-cf-data.test.ts` drives
// the full pipeline, where the `__cfHelpers` import is always injected, so
// `context.cfHelpers.sourceHasHelpers()` is always true. These tests target the
// branches that only run when the source has NO helper import: the primitive
// snapshot classification path (`shouldWrapTopLevelExpression` line 165-167),
// the helper-import injection (`createCfDataHelperImport`), and the union /
// intersection primitive-type analysis. To reach that state the transformer is
// driven directly through `ts.transform`, bypassing the `HelpersOnlyTransformer`
// filter that would otherwise skip a source without helpers.

function createProgram(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
  const files: Record<string, string> = { "/test.ts": source };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (n) => files[n] !== undefined,
    readFile: (n) => files[n],
    getSourceFile: (n, lv) =>
      files[n] !== undefined
        ? ts.createSourceFile(n, files[n]!, lv, true, ts.ScriptKind.TS)
        : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: () => true,
  };
  const program = ts.createProgram(["/test.ts"], options, host);
  return { program, sourceFile: program.getSourceFile("/test.ts")! };
}

// Runs the cf-data transformer directly against a helper-free source. The
// direct call bypasses the `sourceHasHelpers()` filter so the no-helpers
// branches execute.
function transformWithoutHelpers(source: string): string {
  const { program, sourceFile } = createProgram(source);
  const transformer = new ModuleScopeCfDataTransformer({ mode: "transform" });
  const result = ts.transform(sourceFile, [
    (tsContext) => (sf) =>
      transformer.transform(
        new TransformationContext({ program, sourceFile: sf, tsContext }),
      ),
  ]);
  const output = ts
    .createPrinter({ newLine: ts.NewLineKind.LineFeed })
    .printFile(result.transformed[0]);
  result.dispose?.();
  return output;
}

Deno.test(
  "cf-data without helpers wraps a primitive-typed call and injects the __cf_data import",
  () => {
    const output = transformWithoutHelpers(
      `declare function n(): number;\nconst z = n();\n`,
    );
    // With no `__cfHelpers` import present the transformer prepends its own
    // named import and wraps the snapshot call with the bare identifier form.
    assertStringIncludes(
      output,
      'import { __cf_data as __cfDataHelper } from "commonfabric"',
    );
    assertStringIncludes(output, "const z = __cfDataHelper(n())");
  },
);

Deno.test(
  "cf-data without helpers wraps a call whose type is a union of primitives",
  () => {
    const output = transformWithoutHelpers(
      `declare function u(): string | number;\nconst z = u();\n`,
    );
    // A union return type is classified as primitive-like when every member is
    // primitive-like, so the snapshot call is wrapped.
    assertStringIncludes(output, "const z = __cfDataHelper(u())");
  },
);

Deno.test(
  "cf-data without helpers wraps a call whose type is an intersection of primitives",
  () => {
    const output = transformWithoutHelpers(
      `type A = string;\ntype B = string;\ndeclare function u(): A & B;\nconst z = u();\n`,
    );
    // An intersection is primitive-like when every member is primitive-like.
    assertStringIncludes(output, "const z = __cfDataHelper(u())");
  },
);

Deno.test(
  "cf-data without helpers leaves a call whose intersection has a non-primitive member unwrapped",
  () => {
    const output = transformWithoutHelpers(
      `declare function u(): string & { b: string };\nconst z = u();\n`,
    );
    // The object member is not primitive-like, so the intersection fails the
    // `every` check and the call is not treated as a snapshot.
    assert(
      !output.includes("__cfDataHelper"),
      "expected the non-primitive intersection to be left unwrapped",
    );
  },
);

Deno.test(
  "cf-data leaves a declared callable with no body unwrapped on default export",
  () => {
    const output = transformWithoutHelpers(
      `declare function helper(): number;\nexport default helper;\n`,
    );
    // `callableMayReturnCallResult` returns false for a declaration without a
    // body, so the ambient callable is not classified as a default-exported
    // data callable.
    assert(
      !output.includes("__cfDataHelper"),
      "expected the body-less declared callable to be left unwrapped",
    );
  },
);

Deno.test(
  "cf-data wraps a callable that returns a call-on-call result past a nested class boundary and trailing members",
  () => {
    const output = transformWithoutHelpers(
      `declare function factory(): () => number;\n` +
        `const nested = () => ({ make: class {}, a: factory()(), b: 1 });\n` +
        `export default nested;\n`,
    );
    // The nested-expression walk skips the leading class boundary, finds the
    // `factory()()` call-on-call, then short-circuits over the trailing member,
    // classifying `nested` as a default-exported data callable.
    assertStringIncludes(output, "export default __cfDataHelper(nested)");
  },
);

Deno.test(
  "cf-data wraps a block-body callable whose call-on-call return precedes later statements",
  async () => {
    const output = await transformSource(
      `import { pattern } from "commonfabric";\n` +
        `declare function factory(): () => number;\n` +
        `const helper = () => {\n` +
        `  if (true) { return factory()(); }\n` +
        `  const after = 1;\n` +
        `  return after;\n` +
        `};\n` +
        `export default helper;`,
      { types: COMMONFABRIC_TYPES },
    );
    // The block traversal finds the call-on-call return inside the branch, then
    // short-circuits the visit over the remaining statements.
    assertStringIncludes(
      output,
      "export default __cfHelpers.__cf_data(helper)",
    );
  },
);
