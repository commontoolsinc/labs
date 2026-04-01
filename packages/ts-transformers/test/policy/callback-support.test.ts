import { assertEquals } from "@std/assert";
import ts from "typescript";

import { TransformationContext } from "../../src/core/mod.ts";
import { classifyReactiveContext } from "../../src/ast/mod.ts";
import {
  classifyCallbackBoundary,
  getCallbackBoundarySemantics,
} from "../../src/policy/callback-boundary.ts";

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
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "plain-array-value",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.isReactiveArrayMethodCallback, false);
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
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
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "plain-array-value",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.isReactiveArrayMethodCallback, false);
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
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
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.isReactiveArrayMethodCallback, true);
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, true);
  },
);

Deno.test(
  "Callback boundary policy: non-transformed reactive array callbacks inherit parent body context",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function derive<T>(value: T): T;

      const result = derive([1, 2, 3]).map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: transformed array callbacks stay explicit pattern boundaries",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    context.markAsArrayMethodCallback(callback);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "array-method",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: reactive context for transformed array callbacks comes from the shared boundary classifier",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    context.markAsArrayMethodCallback(callback);
    const info = classifyReactiveContext(callback.body, checker, context);

    assertEquals(info.kind, "pattern");
    assertEquals(info.owner, "array-method");
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
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "event-handler",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "handler",
      },
    });
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, false);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback boundary policy: reactive context for event handlers comes from the shared boundary classifier",
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
    const info = classifyReactiveContext(callback.body, checker, context);

    assertEquals(info.kind, "compute");
    assertEquals(info.owner, "handler");
  },
);

Deno.test(
  "Callback boundary policy: unsupported callbacks inside JSX become boundary-owned callback-container errors",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      const view = <div>{[1, 2, 3].forEach((item) => item + 1)}</div>;
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "callback-container",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: unsupported callbacks outside JSX inherit parent context",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const items = [1, 2, 3];
      items.forEach((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: unresolved property-access pattern fallback stays pattern-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const builders = {} as any;
      const value = builders.pattern((input: unknown) => input);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "pattern-builder",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "pattern",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: unresolved property-access patternTool fallback stays compute-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const helpers = {} as any;
      const tool = helpers.patternTool((input: { value?: string }) => input?.value);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "pattern-tool",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: shadowed local pattern helper does not use name-only fallback",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const pattern = <T,>(fn: T) => fn;
      const value = pattern((input: unknown) => input);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "pattern",
    );
    const callback = call.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) {
      throw new Error("Expected inline pattern callback");
    }
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: shadowed local patternTool helper does not use name-only fallback",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const patternTool = <T,>(fn: T) => fn;
      const tool = patternTool((input: { value?: string }) => input?.value);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "patternTool",
    );
    const callback = call.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) {
      throw new Error("Expected inline patternTool callback");
    }
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
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
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "unsupported",
      boundaryKind: "plain-array-void",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, false);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);
