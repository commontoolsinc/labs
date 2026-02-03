import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

export const emitElementAccessExpression = ({
  expression,
  dataFlows,
  analysis,
  context,
  inSafeContext,
}: EmitterContext) => {
  if (!ts.isElementAccessExpression(expression)) return undefined;

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  if (dataFlows.all.length === 0) return undefined;

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );

  if (relevantDataFlows.length === 0) return undefined;

  // Check if this is a static index access
  const argumentExpression = expression.argumentExpression;
  const isStaticIndex = argumentExpression &&
    ts.isExpression(argumentExpression) &&
    (ts.isLiteralExpression(argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(argumentExpression));

  // If it's a static index and doesn't require rewrite, don't wrap it
  if (isStaticIndex && !analysis.requiresRewrite) {
    return undefined;
  }

  const plan = createBindingPlan(relevantDataFlows);
  return createComputedCallForExpression(expression, plan, context);
};
