import ts from "typescript";

import type { Emitter, OpaqueRefHelperName } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

export const emitBinaryExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
}) => {
  if (!ts.isBinaryExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
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
};
