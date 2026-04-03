import ts from "typescript";
import { getCellKind } from "@commontools/schema-generator/cell-brand";

import { classifyOpaquePathTerminalCall } from "../../opaque-roots.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import {
  assertValidComputeWrapCandidate,
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
} from "./compute-wrap-invariants.ts";
import type { Emitter } from "../types.ts";

function isHelperOwnedComputationExpression(
  expression: ts.Expression,
): boolean {
  return ts.isBinaryExpression(expression) ||
    ts.isPrefixUnaryExpression(expression) ||
    ts.isPostfixUnaryExpression(expression) ||
    ts.isConditionalExpression(expression);
}

function isHelperOwnedCellGetExpression(
  expression: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
): expression is ts.CallExpression {
  if (
    !ts.isCallExpression(expression) ||
    classifyOpaquePathTerminalCall(expression) !== "get"
  ) {
    return false;
  }

  const callee = expression.expression;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }

  try {
    const receiverType = context.checker.getTypeAtLocation(callee.expression);
    const cellKind = getCellKind(receiverType, context.checker);
    return cellKind === "cell" || cellKind === "stream";
  } catch {
    return false;
  }
}

interface RewriteHelperOwnedExpressionParams {
  readonly expression: ts.Expression;
  readonly containerLabel: string;
  readonly assertContainer?: ts.Expression;
  readonly context: Parameters<Emitter>[0]["context"];
  readonly analyze: Parameters<Emitter>[0]["analyze"];
  readonly rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"];
}

export function rewriteHelperOwnedExpression(
  params: RewriteHelperOwnedExpressionParams,
): ts.Expression {
  const {
    expression,
    containerLabel,
    assertContainer,
    context,
    analyze,
    rewriteChildren,
  } = params;

  // JSX containers can rewrite their dynamic slots locally via OpaqueRefJSX.
  // Wrapping the whole helper-owned branch here would force later passes to
  // disagree about nested collection lowering.
  if (isJsxLocalRewriteContainer(expression)) {
    return rewriteChildren(expression) || expression;
  }

  const analysis = analyze(expression);
  const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(analysis);

  const pendingRewrite = relevantDataFlows.length > 0
    ? findPendingComputeWrapCandidate(expression, analyze, context)
    : undefined;

  if (pendingRewrite) {
    assertValidComputeWrapCandidate(
      pendingRewrite,
      assertContainer ?? expression,
      containerLabel,
      context,
    );

    const derived = createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
    );
    if (derived) {
      return derived;
    }
  }

  if (
    relevantDataFlows.length > 0 &&
    (
      isHelperOwnedComputationExpression(expression) ||
      isHelperOwnedCellGetExpression(expression, context)
    )
  ) {
    const forced = createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      {
        allowDirectExpressionWrap: true,
      },
    );
    if (forced) {
      return forced;
    }
  }

  return rewriteChildren(expression) || expression;
}
