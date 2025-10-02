import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

export const emitTemplateExpression = ({
  expression,
  dataFlows,
  analysis,
  context,
}: EmitterContext) => {
  if (!ts.isTemplateExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  const plan = createBindingPlan(relevantDataFlows);
  return createDeriveCallForExpression(expression, plan, context);
};
