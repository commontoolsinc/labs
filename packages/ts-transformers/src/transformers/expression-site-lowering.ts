import ts from "typescript";
import { detectCallKind, visitEachChildWithJsx } from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import {
  classifyExpressionSiteHandling,
  containsLogicalBinaryOperator,
  findLowerableExpressionSite,
  getExpressionContainerKind,
  isControlFlowRewriteExpression,
  isDirectArrayMethodRootExpression,
} from "./expression-site-policy.ts";
import { rewriteExpression } from "./expression-rewrite/mod.ts";
import {
  createReactiveWrapperForExpression,
} from "./expression-rewrite/rewrite-helpers.ts";
import type { AnalyzeFn } from "./expression-rewrite/types.ts";
import type { ExpressionContainerKind } from "./expression-site-types.ts";

interface RewriteExpressionSiteParams {
  readonly expression: ts.Expression;
  readonly containerKind: ExpressionContainerKind;
  readonly context: TransformationContext;
  readonly analyze: AnalyzeFn;
  readonly visit: ts.Visitor;
  readonly preferDeriveWrappers?: boolean;
}

function isDirectDeriveCall(
  expression: ts.Expression,
  context: TransformationContext,
): expression is ts.CallExpression {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  return detectCallKind(expression, context.checker)?.kind === "derive";
}

function isSyntheticHelperWrapperInArrayMethodCallback(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  if (!ts.isCallExpression(expression) || expression.pos >= 0) {
    return false;
  }

  const callKind = detectCallKind(expression, context.checker)?.kind;
  if (
    callKind !== "derive" &&
    callKind !== "ifElse" &&
    callKind !== "when" &&
    callKind !== "unless"
  ) {
    return false;
  }

  let current: ts.Node | undefined = expression.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return context.isArrayMethodCallback(current);
    }
    current = current.parent;
  }

  return false;
}

export function rewriteExpressionSite(
  params: RewriteExpressionSiteParams,
): ts.Expression | undefined {
  const {
    expression,
    containerKind,
    context,
    analyze,
    visit,
    preferDeriveWrappers = false,
  } = params;

  const handling = classifyExpressionSiteHandling(
    expression,
    containerKind,
    context,
    analyze,
  );
  if (handling.kind !== "shared") {
    return undefined;
  }

  if (!handling.lowerable) {
    return undefined;
  }

  const contextInfo = context.getReactiveContext(expression);
  const analysis = analyze(expression);
  const hasLogicalOps = containsLogicalBinaryOperator(expression);
  const controlFlowNeedsRewrite = containerKind === "jsx-expression" &&
    isControlFlowRewriteExpression(expression) &&
    analysis.containsOpaqueRef;

  if (!analysis.requiresRewrite && !hasLogicalOps && !controlFlowNeedsRewrite) {
    return undefined;
  }

  if (context.options.mode === "error") {
    if (containerKind === "jsx-expression") {
      context.reportDiagnostic({
        type: "opaque-ref:jsx-expression",
        message: "JSX expression with OpaqueRef computation should use derive",
        node: expression,
      });
    }
    return expression;
  }

  const result = rewriteExpression({
    expression,
    analysis,
    context,
    analyze,
    reactiveContextKind: contextInfo.kind,
    inSafeContext: contextInfo.kind === "compute",
    containerKind,
    preferDeriveWrappers,
  });

  if (!result) {
    return undefined;
  }

  if (preferDeriveWrappers && isDirectDeriveCall(result, context)) {
    return result;
  }

  return visitEachChildWithJsx(
    result,
    visit,
    context.tsContext,
  ) as ts.Expression;
}

// Shared rewrite entrypoint for explicit owned pre-closure JSX roots.
export function rewriteOwnedPreClosureJsxExpressionSite(
  params: Omit<RewriteExpressionSiteParams, "containerKind">,
): ts.Expression | undefined {
  const {
    expression,
    context,
    analyze,
    visit,
    preferDeriveWrappers = false,
  } = params;

  const contextInfo = context.getReactiveContext(expression);
  const inSafeContext = contextInfo.kind === "compute";
  const analysis = analyze(expression);
  const hasLogicalOps = containsLogicalBinaryOperator(expression);

  if (inSafeContext) {
    return undefined;
  }

  if (!analysis.requiresRewrite && !hasLogicalOps) {
    return undefined;
  }

  if (context.options.mode === "error") {
    context.reportDiagnostic({
      type: "opaque-ref:jsx-expression",
      message: "JSX expression with OpaqueRef computation should use derive",
      node: expression,
    });
    return expression;
  }

  const result = rewriteExpression({
    expression,
    analysis,
    context,
    analyze,
    reactiveContextKind: contextInfo.kind,
    inSafeContext,
    containerKind: "jsx-expression",
    preferDeriveWrappers,
  });

  if (!result) {
    return undefined;
  }

  if (preferDeriveWrappers && isDirectDeriveCall(result, context)) {
    return result;
  }

  return visitEachChildWithJsx(
    result,
    visit,
    context.tsContext,
  ) as ts.Expression;
}

export function rewriteHelperOwnedExpressionSites<T extends ts.Node>(
  root: T,
  context: TransformationContext,
): T {
  const analyze = context.getDataFlowAnalyzer();

  const visit: ts.Visitor = (node) => {
    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (ts.isExpression(visited)) {
      const containerKind = getExpressionContainerKind(visited);
      if (containerKind) {
        const handling = classifyExpressionSiteHandling(
          visited,
          containerKind,
          context,
          analyze,
        );
        if (
          handling.kind !== "owned" ||
          handling.owner !== "helper"
        ) {
          return visited;
        }
        if (!handling.lowerable) {
          return visited;
        }
        const analysis = analyze(visited);
        const result = rewriteExpression({
          expression: visited,
          analysis,
          context,
          analyze,
          reactiveContextKind: "pattern",
          inSafeContext: false,
          containerKind,
          preferDeriveWrappers: true,
        });
        if (result) {
          return result;
        }
      }
    }

    return visited;
  };

  return ts.visitNode(root, visit) as T;
}

export function rewritePatternOwnedExpressionSites<T extends ts.Node>(
  root: T,
  context: TransformationContext,
): T {
  const analyze = context.getDataFlowAnalyzer();

  const visit: ts.Visitor = (node) => {
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      context.isArrayMethodCallback(node) &&
      !ts.isBlock(node.body)
    ) {
      return node;
    }

    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const handling = classifyExpressionSiteHandling(
        node.expression,
        "jsx-expression",
        context,
        analyze,
      );
      if (
        handling.kind !== "shared" ||
        (handling.jsxRoute ?? "shared-post-closure") !==
          "shared-post-closure"
      ) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const rewritten = rewriteExpressionSite({
        expression: node.expression,
        containerKind: "jsx-expression",
        context,
        analyze,
        visit,
        preferDeriveWrappers: true,
      });
      if (rewritten) {
        return context.factory.createJsxExpression(
          node.dotDotDotToken,
          rewritten,
        );
      }

      return visitEachChildWithJsx(node, visit, context.tsContext);
    }

    if (ts.isExpression(node)) {
      const containerKind = getExpressionContainerKind(node);
      if (containerKind) {
        if (containerKind === "jsx-expression") {
          return visitEachChildWithJsx(node, visit, context.tsContext);
        }

        // Array-method callback lowering may already have produced a synthetic
        // helper wrapper (derive/ifElse/when/unless) for this subtree. When
        // that happens, the later pattern-owned pass should not re-enter the
        // wrapper root and compete for ownership again.
        if (isSyntheticHelperWrapperInArrayMethodCallback(node, context)) {
          return node;
        }

        const rewritten = rewriteExpressionSite({
          expression: node,
          containerKind,
          context,
          analyze,
          visit,
          preferDeriveWrappers: true,
        });
        if (rewritten) {
          return rewritten;
        }
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return ts.visitNode(root, visit) as T;
}

export function rewriteArrayMethodCallbackExpressionSites(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const analyze = context.getDataFlowAnalyzer();

  const rewriteArrayMethodOwnedReceiverMethodExpressionSite = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    const lowerableSite = findLowerableExpressionSite(
      expression,
      context,
      analyze,
    );
    if (lowerableSite && lowerableSite.expression !== expression) {
      return undefined;
    }

    const containerKind = expression === body
      ? "return-expression"
      : getExpressionContainerKind(expression);
    if (!containerKind || containerKind === "jsx-expression") {
      return undefined;
    }

    const handling = classifyExpressionSiteHandling(
      expression,
      containerKind,
      context,
      analyze,
    );
    if (
      handling.kind !== "owned" ||
      handling.owner !== "array-method-receiver-method" ||
      !handling.lowerable
    ) {
      return undefined;
    }

    const analysis = analyze(expression);
    const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(
      analysis,
    );
    if (relevantDataFlows.length === 0) {
      return undefined;
    }

    return createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      {
        allowDirectExpressionWrap: true,
        preferDeriveWrapper: true,
      },
    );
  };

  const visit: ts.Visitor = (node) => {
    if (
      node !== body &&
      ts.isFunctionLike(node)
    ) {
      return node;
    }

    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (isDirectArrayMethodRootExpression(node.expression)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const handling = classifyExpressionSiteHandling(
        node.expression,
        "jsx-expression",
        context,
        analyze,
      );
      if (
        handling.kind === "owned" &&
        handling.owner === "array-method-callback-jsx" &&
        handling.lowerable
      ) {
        const rewritten = rewriteOwnedPreClosureJsxExpressionSite({
          expression: node.expression,
          context,
          analyze,
          visit,
          preferDeriveWrappers: true,
        });
        if (rewritten) {
          return context.factory.createJsxExpression(
            node.dotDotDotToken,
            rewritten,
          );
        }
      }

      return visitEachChildWithJsx(node, visit, context.tsContext);
    }

    if (ts.isExpression(node)) {
      const containerKind = node === body
        ? "return-expression"
        : getExpressionContainerKind(node);
      if (containerKind && containerKind !== "jsx-expression") {
        const callbackOwnedReceiverRewrite =
          rewriteArrayMethodOwnedReceiverMethodExpressionSite(node);
        if (callbackOwnedReceiverRewrite) {
          return callbackOwnedReceiverRewrite;
        }

        const rewritten = rewriteExpressionSite({
          expression: node,
          containerKind,
          context,
          analyze,
          visit,
          preferDeriveWrappers: true,
        });
        if (rewritten) {
          return rewritten;
        }
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return ts.visitNode(body, visit) as ts.ConciseBody;
}
