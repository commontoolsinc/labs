import { assertEquals, assertExists } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/mod.ts";
import { TransformationContext } from "../../src/core/mod.ts";
import {
  classifyJsxExpressionSiteRoute,
  getExpressionSitePolicyInfo,
} from "../../src/transformers/expression-site-lowering.ts";

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
      declare function identity<T>(value: T): T;

      const callback = (__ct_pattern_input: any) => {
        const row = __ct_pattern_input.key("element");
        const label = identity(row.done ? "Done" : "Pending");
        return label;
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
          span: any;
        }
      }

      declare const rows: any;

      const view = <div>{rows.map((row: any) => row.done ? "Done" : "Pending")}</div>;
    `);

    const mapCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map",
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

Deno.test(
  "Expression site policy: top-level JSX wrapper roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{state.user.name}</div>);
    `);

    const propertyAccess = findFirstNode(
      sourceFile,
      ts.isPropertyAccessExpression,
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(propertyAccess, context, analyze),
      {
        route: "shared-post-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: JSX free-function call roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{Math.max(state.a, state.b)}</div>);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "max",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "free-function");
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: JSX receiver-method call roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{state.name.toUpperCase()}</div>);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "receiver-method");
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: direct JSX join sinks over reactive array-method receivers defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.filter((item: number) => item > state.threshold).join(", ")}</div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "join",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "receiver-method");
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: chained JSX receiver-method sinks over reactive array-method receivers stay on the legacy JSX seam",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.filter((item: number) => item > state.threshold).join(", ").toUpperCase()}</div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "receiver-method");
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "legacy-jsx",
      reason: "contains-reactive-array-method-subexpression",
    });
  },
);

Deno.test(
  "Expression site policy: JSX opaque path-terminal calls stay out of the shared receiver-method slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      interface Cell<T> {
        get(): T;
        key(name: string): Cell<unknown>;
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((input: Cell<{ foo: string }>) => (
        <div>{input.key("foo").get()}</div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "get",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "receiver-method");
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "skip",
      reason: "not-shared-jsx-root-kind",
    });
  },
);

Deno.test(
  "Expression site policy: local helper calls stay out of the shared free-function slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;
      const identity = <T,>(value: T) => value;

      const view = pattern((state: any) => ({
        label: identity(state.name),
      }));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "identity",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "object-property",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "other");
  },
);

Deno.test(
  "Expression site policy: wildcard traversal calls stay out of the shared free-function slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => ({
        serialized: JSON.stringify(state),
      }));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "JSON" &&
        node.expression.name.text === "stringify",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "object-property",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "other");
  },
);

Deno.test(
  "Expression site policy: array-method-owned JSX wrapper roots stay on the legacy JSX seam",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.map((item: any) => <span>{item.name}</span>)}</div>
      ));
    `);

    const callback = findFirstNode(
      sourceFile,
      (node): node is ts.ArrowFunction =>
        ts.isArrowFunction(node) &&
        ts.isJsxElement(node.body),
    );
    context.markAsArrayMethodCallback(callback);

    const propertyAccess = findFirstNode(
      sourceFile,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "item" &&
        node.name.text === "name",
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(propertyAccess, context, analyze),
      { route: "skip", reason: "array-method-owned" },
    );
  },
);

Deno.test(
  "Expression site policy: JSX wrapper roots over reactive array-method results use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.filter((item: any) => item.active).length}</div>
      ));
    `);

    const propertyAccess = findFirstNode(
      sourceFile,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "length" &&
        ts.isCallExpression(node.expression),
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(propertyAccess, context, analyze),
      { route: "shared-post-closure" },
    );
  },
);

Deno.test(
  "Expression site policy: JSX comparison wrappers over reactive array-method results use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.filter((item: any) => item.active).length > 0}</div>
      ));
    `);

    const binary = findFirstNode(
      sourceFile,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken,
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(classifyJsxExpressionSiteRoute(binary, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: pure JSX ternary branches over map subtrees use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.recentEvents.length === 0
            ? <span>No events yet</span>
            : (
              <div>
                {state.recentEvents.map((event: any) => <span>{event.label}</span>)}
              </div>
            )}
        </div>
      ));
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      {
        route: "shared-post-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: length guards over JSX-local map containers use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => {
        return (
          <div>
            {state.list.get().length > 0 && (
              <div>
                {state.list.map((name: string) => <span>{name}</span>)}
              </div>
            )}
          </div>
        );
      });
    `);

    const logical = findFirstNode(
      sourceFile,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(classifyJsxExpressionSiteRoute(logical, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: logical roots with reactive get guards and direct map values use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.recentEvents.get() && state.recentEvents.map((event: any) => <span>{event.label}</span>)}</div>
      ));
    `);

    const logical = findFirstNode(
      sourceFile,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(classifyJsxExpressionSiteRoute(logical, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: JSX-local ternary branch containers with nested scalar lowerables use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
          ul: any;
          li: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.showAdmin
            ? (
              <div>
                <span>{state.count + " people"}</span>
                <ul>
                  {state.adminData.map((entry: any) => <li>{entry.name}</li>)}
                </ul>
              </div>
            )
            : null}
        </div>
      ));
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      {
        route: "shared-post-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: nested logical branches with structural map subtrees use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
          "ct-vstack": any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.showEmpty
            ? <span>No events yet</span>
            : state.recentEvents.get() &&
              state.recentEvents.map((event: any) => (
              <ct-vstack>
                <span>{event.label}</span>
                {event.tags.map((tag: string) => <span>{tag}</span>)}
              </ct-vstack>
              ))}
        </div>
      ));
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      {
        route: "shared-post-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: parenthesized nested ternary branches use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.isActive
            ? (state.isPremium ? "Premium Active" : "Regular Active")
            : "Inactive"}
        </div>
      ));
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      {
        route: "shared-post-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: parenthesized nested logical branches use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.isAdult && (state.name || "Anonymous Adult")}
        </div>
      ));
    `);

    const logical = findFirstNode(
      sourceFile,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(logical, context, analyze),
      {
        route: "shared-post-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: whole-branch compute-wrap ternaries stay on the legacy JSX seam",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.showList
            ? (() => {
              const itemCount = state.count + " items";
              return (
                <div>
                  <span>{itemCount}</span>
                  {state.sorted.map((item: any) => <span>{item.name}</span>)}
                </div>
              );
            })()
            : <span>Hidden</span>}
        </div>
      ));
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      {
        route: "legacy-jsx",
        reason: "legacy-control-flow-branch-local",
      },
    );
  },
);

Deno.test(
  "Expression site policy: array-method-owned JSX wrapper roots with reactive array-method subexpressions stay on the legacy JSX seam",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.people.map((person: any) => (
            <span>{person.tags.filter((tag: any) => tag.active).length}</span>
          ))}
        </div>
      ));
    `);

    const propertyAccess = findFirstNode(
      sourceFile,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "length" &&
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "filter",
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(propertyAccess, context, analyze),
      {
        route: "skip",
        reason: "array-method-owned",
      },
    );
  },
);

Deno.test(
  "Expression site policy: JSX nullish-coalescing roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{state.label ?? "Pending"}</div>);
    `);

    const binary = findFirstNode(sourceFile, ts.isBinaryExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(classifyJsxExpressionSiteRoute(binary, context, analyze), {
      route: "shared-post-closure",
    });
  },
);
