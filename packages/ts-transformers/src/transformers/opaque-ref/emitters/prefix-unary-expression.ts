import ts from "typescript";

import type { Emitter, OpaqueRefHelperName } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { normalizeDataFlows } from "../../../ast/mod.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analysis,
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
    const fallbackAnalysis = context.analyze(expression.operand);
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
  const rewritten = createDeriveCallForExpression(expression, plan, context);
  if (rewritten === expression) return undefined;

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
};
