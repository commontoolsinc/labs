import { assertEquals, assertExists } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/mod.ts";
import { TransformationContext } from "../../src/core/mod.ts";
import {
  classifyJsxExpressionSiteRoute,
  getExpressionSitePolicyInfo,
} from "../../src/transformers/expression-site-policy.ts";

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
  "Expression site policy: reactive direct JSX array-method roots use the explicit deferred array-method owner",
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
        <div>{state.items.map((row: any) => row.done ? "Done" : "Pending")}</div>
      ));
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
    assertEquals(classifyJsxExpressionSiteRoute(mapCall, context, analyze), {
      route: "skip",
      reason: "deferred-jsx-array-method-root",
    });
    assertEquals(
      classifyJsxExpressionSiteRoute(mapCall, context, analyze, {
        allowDeferredRootOwner: true,
      }),
      {
        route: "owned-pre-closure",
        owner: "deferred-jsx-array-method-root",
      },
    );
  },
);

Deno.test(
  "Expression site policy: nested JSX array-method roots inside authored callbacks stay array-method-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          section: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.sections.map((section: any) => (
            <section>
              {section.tasks.map((task: any) => <span>{task.label}</span>)}
            </section>
          ))}
        </div>
      ));
    `);

    const nestedMapCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map" &&
        node.expression.expression.getText(sourceFile) === "section.tasks",
    );

    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      nestedMapCall,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.arrayMethodOwned, true);
    assertEquals(
      classifyJsxExpressionSiteRoute(nestedMapCall, context, analyze),
      {
        route: "skip",
        reason: "array-method-owned",
      },
    );
  },
);

Deno.test(
  "Expression site policy: non-reactive direct JSX array-method roots stay skipped",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const rows = [{ done: true }, { done: false }];
        return <div>{rows.map((row: any) => row.done ? "Done" : "Pending")}</div>;
      });
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
    assertEquals(classifyJsxExpressionSiteRoute(mapCall, context, analyze), {
      route: "skip",
      reason: "deferred-jsx-array-method-root",
    });
    assertEquals(
      classifyJsxExpressionSiteRoute(mapCall, context, analyze, {
        allowDeferredRootOwner: true,
      }),
      {
        route: "skip",
        reason: "deferred-jsx-array-method-root",
      },
    );
  },
);

Deno.test(
  "Expression site policy: reactive dynamic JSX element-access roots use the explicit dynamic element-access owner",
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
        <div>{state.items[state.index]}</div>
      ));
    `);

    const elementAccess = findFirstNode(
      sourceFile,
      (node): node is ts.ElementAccessExpression =>
        ts.isElementAccessExpression(node) &&
        node.getText(sourceFile) === "state.items[state.index]",
    );

    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      elementAccess,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.containerKind, "jsx-expression");
    assertEquals(
      classifyJsxExpressionSiteRoute(elementAccess, context, analyze),
      {
        route: "owned-pre-closure",
        owner: "dynamic-element-access-root",
      },
    );
  },
);

Deno.test(
  "Expression site policy: non-reactive dynamic JSX element-access roots stay in the residual skip bucket",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const rows = ["a", "b", "c"];
        const index = 1;
        return <div>{rows[index]}</div>;
      });
    `);

    const elementAccess = findFirstNode(
      sourceFile,
      (node): node is ts.ElementAccessExpression =>
        ts.isElementAccessExpression(node) &&
        node.getText(sourceFile) === "rows[index]",
    );

    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      elementAccess,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.containerKind, "jsx-expression");
    assertEquals(
      classifyJsxExpressionSiteRoute(elementAccess, context, analyze),
      {
        route: "skip",
        reason: "not-shared-jsx-root-kind",
      },
    );
  },
);

Deno.test(
  "Expression site policy: direct JSX helper-call roots use the explicit helper-call owner",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;
      declare function ifElse<T>(condition: any, whenTrue: T, whenFalse: T): T;

      const view = pattern((state: any) => (
        <div>{ifElse(state.ready, <span>Ready</span>, <span>Waiting</span>)}</div>
      ));
    `);

    const helperCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "ifElse",
    );

    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      helperCall,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "conditional-helper");
    assertEquals(
      classifyJsxExpressionSiteRoute(helperCall, context, analyze),
      {
        route: "owned-pre-closure",
        owner: "helper-call-root",
      },
    );
  },
);

Deno.test(
  "Expression site policy: reactive direct JSX object-literal roots use the explicit object-literal owner",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{{
          color: state.theme.primary,
          fontSize: state.theme.size + "px",
        }}</div>
      ));
    `);

    const objectLiteral = findFirstNode(
      sourceFile,
      (node): node is ts.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(node) &&
        node.getText(sourceFile).includes("color: state.theme.primary"),
    );

    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      objectLiteral,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.containerKind, "jsx-expression");
    assertEquals(
      classifyJsxExpressionSiteRoute(objectLiteral, context, analyze),
      {
        route: "owned-pre-closure",
        owner: "object-literal-root",
      },
    );
  },
);

Deno.test(
  "Expression site policy: non-reactive direct JSX object-literal roots stay in the residual skip bucket",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => (
        <div>{{ color: "red", fontSize: "12px" }}</div>
      ));
    `);

    const objectLiteral = findFirstNode(
      sourceFile,
      ts.isObjectLiteralExpression,
    );

    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      objectLiteral,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.containerKind, "jsx-expression");
    assertEquals(
      classifyJsxExpressionSiteRoute(objectLiteral, context, analyze),
      {
        route: "skip",
        reason: "not-shared-jsx-root-kind",
      },
    );
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
  "Expression site policy: receiver-method chains over reactive array-method sinks defer to the shared post-closure path",
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
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: array-method-owned nested join chains stay out of the shared sink-chain slice",
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
            <span>{person.spotPreferences.map((n: string) => "#" + n).join(", ").toUpperCase()}</span>
          ))}
        </div>
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

    assertEquals(siteInfo.arrayMethodOwned, true);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "skip",
      reason: "array-method-owned",
    });
  },
);

Deno.test(
  "Expression site policy: JSX opaque path-terminal calls use the explicit opaque-path-terminal owner",
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
      route: "owned-pre-closure",
      owner: "opaque-path-terminal-root",
    });
  },
);

Deno.test(
  "Expression site policy: local helper calls stay out of the shared non-JSX free-function slice",
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
  "Expression site policy: JSX local helper call roots with reactive args defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      function previous(value: number) {
        return value - 1;
      }

      const view = pattern((state: any) => <div>{previous(state.value)}</div>);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "previous",
    );
    const analyze = createDataFlowAnalyzer(checker);
    const siteInfo = getExpressionSitePolicyInfo(
      call,
      "jsx-expression",
      context,
      analyze,
    );

    assertEquals(siteInfo.callRootKind, "other");
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
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
  "Expression site policy: array-method-owned JSX wrapper roots stay out of the shared JSX routes",
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
  "Expression site policy: plain-array callback JSX arithmetic roots use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      interface Array<T> {
        map<U>(callback: (value: T) => U): U[];
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{[1, 2, 3].map((n: number) => <span>{n * state.multiplier}</span>)}</div>
      ));
    `);

    const binary = findFirstNode(
      sourceFile,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        node.left.text === "n" &&
        ts.isPropertyAccessExpression(node.right) &&
        ts.isIdentifier(node.right.expression) &&
        node.right.expression.text === "state" &&
        node.right.name.text === "multiplier",
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(binary, context, analyze),
      { route: "shared-post-closure" },
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
  "Expression site policy: logical JSX branches with non-JSX wrapper roots use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          p: any;
        }
      }

      declare function cell<T>(value: T): { get(): T };
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const user = cell<{ name: string; age: number }>({ name: "", age: 0 });
        return (
          <div>
            <p>{user.get().name.length > 0 && \`Hello, \${user.get().name}!\`}</p>
            <p>{user.get().age > 18 && user.get().age}</p>
          </div>
        );
      });
    `);

    const logicalBranches: ts.BinaryExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        logicalBranches.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const analyze = createDataFlowAnalyzer(checker);

    for (const logical of logicalBranches) {
      assertEquals(
        classifyJsxExpressionSiteRoute(logical, context, analyze),
        {
          route: "shared-post-closure",
        },
      );
    }
  },
);

Deno.test(
  "Expression site policy: ternary JSX branches with non-JSX wrapper roots use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          p: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          <p>{state.arr[state.a]! > 10 ? state.items[state.b]! : state.items[0]!}</p>
          <p>{state.user.settings.notifications
            ? state.user.name + " has notifications on with " + state.user.settings.theme + " theme"
            : state.user.name + " has notifications off"}</p>
        </div>
      ));
    `);

    const conditionals: ts.ConditionalExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isConditionalExpression(node)) {
        conditionals.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const analyze = createDataFlowAnalyzer(checker);

    for (const conditional of conditionals) {
      assertEquals(
        classifyJsxExpressionSiteRoute(conditional, context, analyze),
        {
          route: "shared-post-closure",
        },
      );
    }
  },
);

Deno.test(
  "Expression site policy: logical JSX fallbacks with opaque path-terminal call values use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function cell<T>(value: T): { get(): T };
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const user = cell<{ name: string }>({ name: "" });
        const defaultMessage = cell("Guest");
        return (
          <div>
            <span>{(user.get().name.length > 0 && user.get().name) || defaultMessage.get()}</span>
          </div>
        );
      });
    `);

    const logical = findFirstNode(
      sourceFile,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken,
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
  "Expression site policy: ternary JSX branches with opaque path-terminal call values use the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function cell<T>(value: T): { get(): T };
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const user = cell<{ name: string }>({ name: "" });
        const defaultMessage = cell("Guest");
        return (
          <div>
            <span>{user.get().name.length > 0 ? user.get().name : defaultMessage.get()}</span>
          </div>
        );
      });
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
  "Expression site policy: whole-branch compute-wrap ternaries use the shared pre-closure path",
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
        route: "shared-pre-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: ternary branches with direct deferred JSX array-method roots use the shared pre-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
          p: any;
        }
      }

      type Cell<T> = T & { get(): T };

      declare function pattern<T>(fn: (state: any) => T): T;
      declare function computed<T>(fn: () => T): T;

      interface Item {
        name: string;
      }

      const view = pattern(({ items }: { items: Cell<Item[]> }) => {
        const hasItems = computed(() => items.get().length > 0);
        return <div>{
          hasItems
            ? items.map((item) => <span>{item.name}</span>)
            : <p>No items</p>
        }</div>;
      });
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      { route: "shared-pre-closure" },
    );
  },
);

Deno.test(
  "Expression site policy: array-method-owned JSX wrapper roots with reactive array-method subexpressions stay out of the shared JSX routes",
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
