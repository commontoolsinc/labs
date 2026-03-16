import ts from "typescript";

import { normalizeDataFlows } from "../../../ast/mod.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import {
  assertValidComputeWrapCandidate,
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
} from "./compute-wrap-invariants.ts";
import type { Emitter } from "../types.ts";

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

    const plan = createBindingPlan(relevantDataFlows);
    const derived = createComputedCallForExpression(expression, plan, context);
    if (derived) {
      return derived;
    }
  }

  return rewriteChildren(expression) || expression;
}
