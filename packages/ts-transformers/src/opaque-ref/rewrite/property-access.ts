import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { EmitterParams, EmitterResult } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "./helpers.ts";
import { isSafeEventHandlerCall } from "./event-handlers.ts";

export function emitPropertyAccess(
  params: EmitterParams,
): EmitterResult | undefined {
  const { expression, dataFlows, context } = params;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  if (dataFlows.all.length === 0) return undefined;
  if (
    expression.parent &&
    ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression
  ) {
    if (!isSafeEventHandlerCall(expression.parent)) return undefined;
  }

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    params.analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  const plan = createBindingPlan(relevantDataFlows);
  const rewritten = createDeriveCallForExpression(expression, plan, context);
  if (rewritten === expression) return undefined;

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
}
