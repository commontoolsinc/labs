import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { createWhenCall } from "../../builtins/ifelse.ts";
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

    // Only apply when optimization if left side has opaque refs (needs derive)
    // Right side is handled by rewriteChildren which processes any opaque refs appropriately
    if (shouldDeriveLeft) {
      let predicate: ts.Expression = expression.left;
      const plan = createBindingPlan(leftDataFlows);
      const derivedPredicate = createDeriveCallForExpression(
        expression.left,
        plan,
        context,
      );
      if (derivedPredicate) {
        predicate = derivedPredicate;
      }

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

  // Fallback: wrap entire expression in derive (original behavior)
  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  const plan = createBindingPlan(relevantDataFlows);
  return createDeriveCallForExpression(expression, plan, context);
};
