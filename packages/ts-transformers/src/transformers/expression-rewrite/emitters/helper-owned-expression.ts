import ts from "typescript";

import { normalizeDataFlows } from "../../../ast/mod.ts";
import {
  createReactiveWrapperForExpression,
  filterRelevantDataFlows,
} from "../rewrite-helpers.ts";
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
  const relevantDataFlows = filterRelevantDataFlows(
    normalizeDataFlows(
      analysis.graph,
      analysis.dataFlows,
    ).all,
    analysis,
    context,
  );

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
    isHelperOwnedComputationExpression(expression)
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
