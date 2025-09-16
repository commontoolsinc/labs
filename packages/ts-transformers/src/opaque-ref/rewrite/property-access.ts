import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { EmitterParams, EmitterResult } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDependencies,
} from "./helpers.ts";
import { isSafeEventHandlerCall } from "./event-handlers.ts";

export function emitPropertyAccess(
  params: EmitterParams,
): EmitterResult | undefined {
  const { expression, dependencies, context } = params;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  if (dependencies.all.length === 0) return undefined;
  if (
    expression.parent &&
    ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression
  ) {
    if (!isSafeEventHandlerCall(expression.parent)) return undefined;
  }

  const relevantDependencies = filterRelevantDependencies(
    dependencies.all,
    params.analysis,
    context,
  );
  if (relevantDependencies.length === 0) return undefined;

  const plan = createBindingPlan(relevantDependencies);
  return {
    expression: createDeriveCallForExpression(expression, plan, context),
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
}
