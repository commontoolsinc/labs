import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import { shouldDeferFallbackMapReceiverRewrite } from "../fallback-array-method-rewrite.ts";
import {
  assertValidComputeWrapCandidate,
  findPendingComputeWrapCandidate,
} from "./compute-wrap-invariants.ts";
import { createUnlessCall, createWhenCall } from "../../builtins/ifelse.ts";
import {
  isReactiveValueExpression,
  isSimpleReactiveAccessExpression,
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { shouldLowerLogicalExpression } from "../../../policy/mod.ts";

export const emitBinaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analyze,
  rewriteSubexpression,
  inSafeContext,
  reactiveContextKind,
  containerKind,
  preferDeriveWrappers,
}) => {
  if (!ts.isBinaryExpression(expression)) return undefined;
  const operator = expression.operatorToken.kind;
  const shouldLowerByContextPolicy = shouldLowerLogicalExpression(
    reactiveContextKind,
    containerKind ?? "jsx-expression",
    operator,
  );

  // Check if the left side of && or || has a reactive type.
  // This is important for cases like `computed(() => plainValue) && <JSX>`
  // where the computed() returns a reactive value but doesn't contain reactive
  // refs in its inputs.
  const leftIsOpaqueRef = isReactiveValueExpression(
    expression.left,
    context.checker,
  );

  // Skip if no dataflows AND left side isn't reactive
  if (
    dataFlows.length === 0 &&
    !leftIsOpaqueRef &&
    !shouldLowerByContextPolicy
  ) {
    return undefined;
  }

  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
    if (!shouldLowerByContextPolicy) {
      if (inSafeContext) return undefined;
    }

    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );

    if (shouldLowerByContextPolicy) {
      let condition: ts.Expression = expression.left;
      if (leftDataFlows.length > 0) {
        if (
          !isSimpleReactiveAccessExpression(expression.left, context.checker)
        ) {
          const computedCondition = createReactiveWrapperForExpression(
            expression.left,
            leftDataFlows,
            context,
            { preferDeriveWrapper: preferDeriveWrappers },
          );
          if (computedCondition) {
            condition = computedCondition;
          }
        }
      }

      const value = rewriteSubexpression(expression.right);

      const whenCall = createWhenCall({
        condition,
        value,
        factory: context.factory,
        ctHelpers: context.ctHelpers,
      });

      if (context.options.typeRegistry) {
        const resultType = context.checker.getTypeAtLocation(expression);
        registerSyntheticCallType(
          whenCall,
          resultType,
          context.options.typeRegistry,
        );
      }

      return whenCall;
    }
  }

  if (operator === ts.SyntaxKind.BarBarToken) {
    if (!shouldLowerByContextPolicy) {
      if (inSafeContext) return undefined;
    }

    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );

    if (shouldLowerByContextPolicy) {
      let condition: ts.Expression = expression.left;
      if (leftDataFlows.length > 0) {
        if (
          !isSimpleReactiveAccessExpression(expression.left, context.checker)
        ) {
          const computedCondition = createReactiveWrapperForExpression(
            expression.left,
            leftDataFlows,
            context,
            { preferDeriveWrapper: preferDeriveWrappers },
          );
          if (computedCondition) {
            condition = computedCondition;
          }
        }
      }

      const value = rewriteSubexpression(expression.right);

      const unlessCall = createUnlessCall({
        condition,
        value,
        factory: context.factory,
        ctHelpers: context.ctHelpers,
      });

      if (context.options.typeRegistry) {
        const resultType = context.checker.getTypeAtLocation(expression);
        registerSyntheticCallType(
          unlessCall,
          resultType,
          context.options.typeRegistry,
        );
      }

      return unlessCall;
    }
  }

  if (inSafeContext) {
    return undefined;
  }

  if (dataFlows.length === 0) return undefined;

  if (
    reactiveContextKind === "pattern" &&
    shouldDeferFallbackMapReceiverRewrite(expression, context.checker)
  ) {
    return undefined;
  }

  const pendingWrap = findPendingComputeWrapCandidate(
    expression,
    analyze,
    context,
  );
  if (!pendingWrap) return undefined;

  assertValidComputeWrapCandidate(
    pendingWrap,
    expression,
    "binary expression",
    context,
  );

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferDeriveWrapper: preferDeriveWrappers,
    },
  );
};
