import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

export const emitTaggedTemplateExpression = ({
  expression,
  dataFlows,
  analysis,
  context,
}: EmitterContext) => {
  if (!ts.isTaggedTemplateExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  // The tagged template expression contains opaque refs in its template spans
  // We need to wrap the entire expression in a derive call
  // No need to rewrite the template itself, just wrap it
  const plan = createBindingPlan(relevantDataFlows);
  return createDeriveCallForExpression(expression, plan, context);
};
