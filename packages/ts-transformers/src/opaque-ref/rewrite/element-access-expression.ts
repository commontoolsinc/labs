import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "./helpers.ts";

export const emitElementAccessExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
}) => {
  if (!ts.isElementAccessExpression(expression)) return undefined;
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
  const rewritten = createDeriveCallForExpression(expression, plan, context);
  if (rewritten === expression) return undefined;

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
};
