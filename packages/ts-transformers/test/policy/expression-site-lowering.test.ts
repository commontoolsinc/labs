import { assertEquals, assertExists } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/mod.ts";
import { TransformationContext } from "../../src/core/mod.ts";
import { getExpressionSitePolicyInfo } from "../../src/transformers/expression-site-lowering.ts";

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

function findVariableInitializer(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.Expression {
  let found: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Initializer for ${declarationName} not found`);
  }

  return found;
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
  "Expression site policy: array-method callback call arguments are tracked separately from helper-owned branches",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function wrap<T>(value: T): T;

      const callback = (__ct_pattern_input: any) => {
        const row = __ct_pattern_input.key("element");
        const wrapped = wrap(row.done ? "Done" : "Pending");
        return wrapped;
      };
    `);

    const callback = findVariableInitializer(sourceFile, "callback");
    if (!ts.isArrowFunction(callback)) {
      throw new Error("Expected callback arrow function");
    }
    context.markAsArrayMethodCallback(callback);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      conditional,
      "call-argument",
      context,
      analyze,
    );

    assertEquals(siteInfo.arrayMethodOwned, true);
    assertEquals(siteInfo.helperBoundaryKind, undefined);
    assertEquals(siteInfo.controlFlowRewriteRoot, true);
    assertEquals(siteInfo.reactiveContext.owner, "array-method");
  },
);

Deno.test(
  "Expression site policy: authored ifElse branches are marked as helper-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function ifElse<A, B, C>(cond: A, ifTrue: B, ifFalse: C): B | C;

      const callback = (__ct_pattern_input: any) => {
        const row = __ct_pattern_input.key("element");
        const branch = ifElse(row.done, row.label ? "Done" : "Pending", "Fallback");
        return branch;
      };
    `);

    const callback = findVariableInitializer(sourceFile, "callback");
    if (!ts.isArrowFunction(callback)) {
      throw new Error("Expected callback arrow function");
    }
    context.markAsArrayMethodCallback(callback);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      conditional,
      "call-argument",
      context,
      analyze,
    );

    assertEquals(siteInfo.arrayMethodOwned, true);
    assertEquals(siteInfo.helperBoundaryKind, "ifElse");
  },
);

Deno.test(
  "Expression site policy: JSX map expressions are marked as deferred array-method sites",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare const rows: any;

      const view = <div>{rows.map((row: any) => row.done ? "Done" : "Pending")}</div>;
    `);

    const mapCall = findFirstNode(sourceFile, (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      mapCall,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.deferredJsxArrayMethod, true);
    assertEquals(siteInfo.containerKind, "jsx-expression");
  },
);

Deno.test(
  "Expression site policy: synthetic compute-owned authored subtrees are visible in site metadata",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => {
        const label = state.done ? state.name : "Pending";
        return label;
      });
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    context.markSyntheticComputeOwnedSubtree(conditional);

    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      conditional,
      "variable-initializer",
      context,
      analyze,
    );

    assertExists(siteInfo.syntheticComputeOwned);
    assertEquals(siteInfo.syntheticComputeOwned, true);
    assertEquals(siteInfo.reactiveContext.kind, "compute");
  },
);
