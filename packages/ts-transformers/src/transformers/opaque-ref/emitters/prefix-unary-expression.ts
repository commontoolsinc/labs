import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { normalizeDataFlows } from "../../../ast/mod.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analysis,
  analyze,
}) => {
  if (!ts.isPrefixUnaryExpression(expression)) return undefined;
  if (expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return undefined;
  }
  if (dataFlows.all.length === 0) return undefined;

  let relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );

  if (relevantDataFlows.length === 0 && analysis.containsOpaqueRef) {
    const fallbackAnalysis = analyze(expression.operand);
    const fallbackDataFlows = normalizeDataFlows(
      fallbackAnalysis.graph,
      fallbackAnalysis.dataFlows,
    );
    relevantDataFlows = filterRelevantDataFlows(
      fallbackDataFlows.all,
      fallbackAnalysis,
      context,
    );

    if (relevantDataFlows.length === 0) return undefined;
  } else if (relevantDataFlows.length === 0) {
    return undefined;
  }

  const plan = createBindingPlan(relevantDataFlows);
  return createComputedCallForExpression(expression, plan, context);
};
