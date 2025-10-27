import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
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

  // Optimize && operator: convert to ifElse instead of wrapping entire expression in derive
  // Example: foo.length > 0 && <div>...</div>
  // Becomes: ifElse(derive(foo, foo => foo.length > 0), <div>...</div>, null)
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );
    const rightDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.right,
    );

    const shouldDeriveLeft = leftDataFlows.length > 0 &&
      !isSimpleOpaqueRefAccess(expression.left, context.checker);

    // Only apply ifElse optimization if:
    // 1. Left side has opaque refs (needs derive)
    // 2. Right side either has no opaque refs OR is simple enough (like JSX)
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
      const whenTrue = rewriteChildren(expression.right) || expression.right;

      // Create ifElse(predicate, whenTrue, null)
      // We need to create a synthetic conditional expression to pass to createIfElseCall
      const syntheticConditional = context.factory.createConditionalExpression(
        predicate,
        context.factory.createToken(ts.SyntaxKind.QuestionToken),
        whenTrue,
        context.factory.createToken(ts.SyntaxKind.ColonToken),
        context.factory.createNull(),
      );

      return createIfElseCall({
        expression: syntheticConditional,
        factory: context.factory,
        ctHelpers: context.ctHelpers,
        sourceFile: context.sourceFile,
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
