import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDependencies,
} from "./helpers.ts";

export const emitElementAccessExpression: Emitter = ({
  expression,
  dependencies,
  analysis,
  context,
}) => {
  if (!ts.isElementAccessExpression(expression)) return undefined;
  if (dependencies.all.length === 0) return undefined;

  const relevantDependencies = filterRelevantDependencies(
    dependencies.all,
    analysis,
    context,
  );
  if (relevantDependencies.length === 0) return undefined;

  const plan = createBindingPlan(relevantDependencies);
  const rewritten = createDeriveCallForExpression(expression, plan, context);
  if (rewritten === expression) return undefined;

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
};
