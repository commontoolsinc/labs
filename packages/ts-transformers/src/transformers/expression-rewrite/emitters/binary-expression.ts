import ts from "typescript";

import type { Emitter, EmitterContext } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import { shouldDeferFallbackMapReceiverRewrite } from "../fallback-array-method-rewrite.ts";
import {
  findPendingComputeWrapCandidate,
  resolveComputeWrapCandidate,
} from "./compute-wrap-invariants.ts";
import { createUnlessCall, createWhenCall } from "../../builtins/ifelse.ts";
import {
  classifyArrayMethodCall,
  isReactiveValueExpression,
  isSimpleReactiveAccessExpression,
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { shouldLowerLogicalExpression } from "../../../policy/mod.ts";

function getTransparentReceiverWrappedExpression(
  node: ts.Node,
): ts.Expression | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isPartiallyEmittedExpression(node)
  ) {
    return node.expression;
  }
  return undefined;
}

function isArrayMethodReceiverExpression(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent) {
    const wrapped = getTransparentReceiverWrappedExpression(parent);
    if (!wrapped) break;
    if (wrapped !== current) return false;
    current = parent;
    parent = parent.parent;
  }

  if (
    !parent ||
    (
      !ts.isPropertyAccessExpression(parent) &&
      !ts.isElementAccessExpression(parent)
    ) ||
    parent.expression !== current
  ) {
    return false;
  }

  const call = parent.parent;
  return !!call && ts.isCallExpression(call) && call.expression === parent &&
    !!classifyArrayMethodCall(call);
}

function isAllowedSyntheticArrayReceiverWrap(
  node: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
): boolean {
  return context.getReactiveContext(node).kind === "compute" &&
    context.isSyntheticComputeOwnedNode(node) &&
    isArrayMethodReceiverExpression(node);
}

function preferLocalIdentifierDataFlows(
  dataFlows: EmitterContext["dataFlows"],
): EmitterContext["dataFlows"] {
  const identifiers = dataFlows.filter((dataFlow) =>
    ts.isIdentifier(dataFlow.expression)
  );
  return identifiers.length > 0 ? identifiers : dataFlows;
}

export const emitBinaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analyze,
  rewriteSubexpression,
  inSafeContext,
  reactiveContextKind,
  containerKind,
  preferInputBoundWrappers,
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
  const leftIsReactive = isReactiveValueExpression(
    expression.left,
    context.checker,
  );

  // Skip if no dataflows AND left side isn't reactive
  if (
    dataFlows.length === 0 &&
    !leftIsReactive &&
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
            { preferInputBoundWrapper: preferInputBoundWrappers },
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
        cfHelpers: context.cfHelpers,
      });

      if (context.options.state?.typeRegistry) {
        const resultType = context.checker.getTypeAtLocation(expression);
        registerSyntheticCallType(
          whenCall,
          resultType,
          context.options.state?.typeRegistry,
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
            { preferInputBoundWrapper: preferInputBoundWrappers },
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
        cfHelpers: context.cfHelpers,
      });

      if (context.options.state?.typeRegistry) {
        const resultType = context.checker.getTypeAtLocation(expression);
        registerSyntheticCallType(
          unlessCall,
          resultType,
          context.options.state?.typeRegistry,
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

  const allowedSyntheticArrayReceiverWrap = isAllowedSyntheticArrayReceiverWrap(
    pendingWrap,
    context,
  );

  if (!allowedSyntheticArrayReceiverWrap) {
    const decision = resolveComputeWrapCandidate(
      pendingWrap,
      expression,
      "binary expression",
      context,
    );
    if (decision.kind === "skip-reported") {
      // Return the expression unrewritten (truthy) so no later emitter
      // re-attempts the wrap.
      return expression;
    }
  }

  return createReactiveWrapperForExpression(
    expression,
    allowedSyntheticArrayReceiverWrap
      ? preferLocalIdentifierDataFlows(dataFlows)
      : dataFlows,
    context,
    {
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
};
