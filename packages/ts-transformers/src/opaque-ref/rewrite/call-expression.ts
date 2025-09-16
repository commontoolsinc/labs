import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDependencies,
} from "./helpers.ts";

export const emitCallExpression: Emitter = ({
  expression,
  dependencies,
  context,
  analysis,
}) => {
  if (!ts.isCallExpression(expression)) return undefined;
  if (dependencies.all.length === 0) return undefined;

  const hint = analysis.rewriteHint;

  if (hint?.kind === "skip-call-rewrite" || hint?.kind === "call-if-else") {
    return undefined;
  }

  const relevantDependencies = filterRelevantDependencies(
    dependencies.all,
    analysis,
    context,
  );
  if (relevantDependencies.length === 0) return undefined;

  const plan = createBindingPlan(relevantDependencies);
  const rewritten = createDeriveCallForExpression(expression, plan, context);

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
};
