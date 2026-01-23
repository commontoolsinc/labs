import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { selectDataFlowsWithin } from "../../../ast/mod.ts";

export const emitCallExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analysis,
  rewriteChildren,
  inSafeContext,
}) => {
  if (!ts.isCallExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  const hint = analysis.rewriteHint;

  if (hint?.kind === "skip-call-rewrite") {
    if (hint.reason === "array-map") {
      // For array-map calls (e.g., state.items.filter(...).map(...)),
      // we don't wrap the map call itself, but we DO need to rewrite
      // the call chain before .map to wrap reactive expressions

      // If the callee is a property access (e.g., ...filter(...).map),
      // recursively rewrite the entire callee to handle wrapped expressions
      const rewrittenCallee = rewriteChildren(expression.expression);

      if (rewrittenCallee !== expression.expression) {
        // The callee was rewritten, update the map call
        return context.factory.updateCallExpression(
          expression,
          rewrittenCallee as ts.LeftHandSideExpression,
          expression.typeArguments,
          expression.arguments,
        );
      }

      // No changes needed
      return undefined;
    }
    return undefined;
  }

  if (hint?.kind === "call-if-else") {
    const predicateDataFlows = selectDataFlowsWithin(
      dataFlows,
      hint.predicate,
    );
    const relevantPredicateDataFlows = filterRelevantDataFlows(
      predicateDataFlows,
      analysis,
      context,
    );

    let rewrittenPredicate: ts.Expression = hint.predicate;
    if (relevantPredicateDataFlows.length > 0) {
      const plan = createBindingPlan(relevantPredicateDataFlows);
      const derivedPredicate = createComputedCallForExpression(
        hint.predicate,
        plan,
        context,
      );
      if (derivedPredicate && derivedPredicate !== hint.predicate) {
        rewrittenPredicate = derivedPredicate;
      }
    } else {
      const child = rewriteChildren(hint.predicate);
      if (child !== hint.predicate) {
        rewrittenPredicate = child;
      }
    }

    const rewrittenCallee = rewriteChildren(expression.expression);
    const rewrittenArgs: ts.Expression[] = [];
    let changed = rewrittenCallee !== expression.expression;

    expression.arguments.forEach((argument, index) => {
      let updated: ts.Expression = argument;
      if (index === 0) {
        updated = rewrittenPredicate;
      } else {
        const child = rewriteChildren(argument);
        if (child !== argument) {
          updated = child;
        }
      }
      if (updated !== argument) changed = true;
      rewrittenArgs.push(updated);
    });

    if (!changed) return undefined;

    return context.factory.updateCallExpression(
      expression,
      rewrittenCallee,
      expression.typeArguments,
      rewrittenArgs,
    );
  }

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) {
    return undefined;
  }

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  const plan = createBindingPlan(relevantDataFlows);
  return createComputedCallForExpression(expression, plan, context);
};
