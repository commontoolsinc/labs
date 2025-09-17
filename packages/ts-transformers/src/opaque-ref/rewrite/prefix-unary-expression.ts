import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDependencies,
} from "./helpers.ts";
import { normaliseDependencies } from "../normalise.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dependencies,
  context,
  analysis,
}) => {
  if (!ts.isPrefixUnaryExpression(expression)) return undefined;
  if (expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return undefined;
  }
  if (dependencies.all.length === 0) return undefined;

  let relevantDependencies = filterRelevantDependencies(
    dependencies.all,
    analysis,
    context,
  );

  if (relevantDependencies.length === 0 && analysis.containsOpaqueRef) {
    const fallbackAnalysis = context.analyze(expression.operand);
    const fallbackDependencies = normaliseDependencies(
      fallbackAnalysis.graph,
    );
    relevantDependencies = filterRelevantDependencies(
      fallbackDependencies.all,
      fallbackAnalysis,
      context,
    );

    if (relevantDependencies.length === 0) return undefined;
  } else if (relevantDependencies.length === 0) {
    return undefined;
  }

  const plan = createBindingPlan(relevantDependencies);
  const rewritten = createDeriveCallForExpression(expression, plan, context);

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
};
