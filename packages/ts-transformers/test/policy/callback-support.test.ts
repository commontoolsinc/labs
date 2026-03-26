import { assertEquals } from "@std/assert";
import ts from "typescript";

import { TransformationContext } from "../../src/core/mod.ts";
import {
  allowsRestrictedContextFunctionCallback,
  classifyCallbackSupport,
  isReactiveArrayMethodCallbackSupport,
  supportsPatternOwnedWrapperCallbackSite,
} from "../../src/transformers/callback-support.ts";

function createProgramAndContext(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  context: TransformationContext;
} {
  const fileName = "/test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TSX,
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
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: {
      typeRegistry: new WeakMap(),
      mapCallbackRegistry: new WeakSet(),
      syntheticComputeCallbackRegistry: new WeakSet(),
      syntheticComputeOwnedNodeRegistry: new WeakSet(),
      schemaHints: new WeakMap(),
      capabilitySummaryRegistry: new WeakMap(),
    },
  });

  return { sourceFile, checker: program.getTypeChecker(), context };
}

function findFirstNode<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error("Expected node not found");
  }

  return found;
}

Deno.test(
  "Callback support policy: plain array map callbacks stay plain-array value callbacks",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackSupport(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      supportedKind: "plain-array-value",
    });
    assertEquals(isReactiveArrayMethodCallbackSupport(decision), false);
    assertEquals(allowsRestrictedContextFunctionCallback(decision), true);
    assertEquals(supportsPatternOwnedWrapperCallbackSite(decision), false);
  },
);

Deno.test(
  "Callback support policy: plain array find callbacks stay plain-array value callbacks",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      interface Array<T> {
        find(callback: (value: T) => boolean): T | undefined;
      }

      const items = [1, 2, 3];
      const result = items.find((item) => item > 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackSupport(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      supportedKind: "plain-array-value",
    });
    assertEquals(isReactiveArrayMethodCallbackSupport(decision), false);
    assertEquals(allowsRestrictedContextFunctionCallback(decision), true);
    assertEquals(supportsPatternOwnedWrapperCallbackSite(decision), false);
  },
);

Deno.test(
  "Callback support policy: reactive array-method callbacks stay reactive-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function derive<T>(value: T): T;

      const result = derive([1, 2, 3]).map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackSupport(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      supportedKind: "reactive-array-method",
    });
    assertEquals(isReactiveArrayMethodCallbackSupport(decision), true);
    assertEquals(allowsRestrictedContextFunctionCallback(decision), true);
    assertEquals(supportsPatternOwnedWrapperCallbackSite(decision), true);
  },
);

Deno.test(
  "Callback support policy: event handlers stay outside the generic safe-wrapper callback bucket",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          button: any;
        }
      }

      const view = <button onClick={() => 1} />;
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackSupport(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      supportedKind: "event-handler",
    });
    assertEquals(allowsRestrictedContextFunctionCallback(decision), false);
    assertEquals(supportsPatternOwnedWrapperCallbackSite(decision), false);
  },
);

Deno.test(
  "Callback support policy: foreign void array containers remain unsupported",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      interface Array<T> {
        forEach(callback: (value: T) => void): void;
      }

      const items = [1, 2, 3];
      items.forEach((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackSupport(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      unsupportedKind: "plain-array-void",
    });
    assertEquals(allowsRestrictedContextFunctionCallback(decision), false);
    assertEquals(supportsPatternOwnedWrapperCallbackSite(decision), false);
  },
);
