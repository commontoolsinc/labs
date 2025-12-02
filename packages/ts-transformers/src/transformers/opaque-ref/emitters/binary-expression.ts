import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { createUnlessCall, createWhenCall } from "../../builtins/ifelse.ts";
import { selectDataFlowsReferencedIn } from "../../../ast/mod.ts";
import { isSimpleOpaqueRefAccess } from "../opaque-ref.ts";

export const emitBinaryExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
  rewriteChildren,
}) => {
  if (!ts.isBinaryExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  // Optimize && operator: convert to when instead of wrapping entire expression in derive
  // Example: foo.length > 0 && <div>...</div>
  // Becomes: when(derive(foo, foo => foo.length > 0), <div>...</div>)
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );

    const shouldDeriveLeft = leftDataFlows.length > 0 &&
      !isSimpleOpaqueRefAccess(expression.left, context.checker);

    // Only apply when optimization if left side has opaque refs (needs computed)
    // Right side is handled by rewriteChildren which processes any opaque refs appropriately
    if (shouldDeriveLeft) {
      const plan = createBindingPlan(leftDataFlows);
      const computedPredicate = createComputedCallForExpression(
        expression.left,
        plan,
        context,
      );
      // If we couldn't create a computed call, fall back to original expression
      const predicate = computedPredicate ?? expression.left;

      // Process right side - rewrite children but don't wrap whole thing in derive
      const value = rewriteChildren(expression.right) || expression.right;

      // Create when(predicate, value)
      // This is equivalent to: ifElse(predicate, value, predicate)
      // Preserves && semantics where falsy values are returned as-is
      return createWhenCall({
        condition: predicate,
        value,
        factory: context.factory,
        ctHelpers: context.ctHelpers,
      });
    }
  }

  // Optimize || operator: convert to unless instead of wrapping entire expression in derive
  // Example: fallbackValue || <div>...</div>
  // Becomes: unless(derive(fallbackValue, v => v), <div>...</div>)
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );

    const shouldDeriveLeft = leftDataFlows.length > 0 &&
      !isSimpleOpaqueRefAccess(expression.left, context.checker);

    // Only apply unless optimization if left side has opaque refs (needs computed)
    // Right side is handled by rewriteChildren which processes any opaque refs appropriately
    if (shouldDeriveLeft) {
      const plan = createBindingPlan(leftDataFlows);
      const computedCondition = createComputedCallForExpression(
        expression.left,
        plan,
        context,
      );
      // If we couldn't create a computed call, fall back to original expression
      const condition = computedCondition ?? expression.left;

      // Process right side - rewrite children but don't wrap whole thing in derive
      const value = rewriteChildren(expression.right) || expression.right;

      // Create unless(condition, value)
      // This is equivalent to: ifElse(condition, condition, value)
      // Preserves || semantics where truthy values are returned as-is
      return createUnlessCall({
        condition,
        value,
        factory: context.factory,
        ctHelpers: context.ctHelpers,
      });
    }
  }

  // Fallback: wrap entire expression in derive (original behavior)
  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  const plan = createBindingPlan(relevantDataFlows);
  return createComputedCallForExpression(expression, plan, context);
};
