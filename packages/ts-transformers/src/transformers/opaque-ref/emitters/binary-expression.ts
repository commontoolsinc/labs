import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import {
  assertValidComputeWrapCandidate,
  findPendingComputeWrapCandidate,
} from "./compute-wrap-invariants.ts";
import { createUnlessCall, createWhenCall } from "../../builtins/ifelse.ts";
import {
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { isOpaqueRefType, isSimpleOpaqueRefAccess } from "../opaque-ref.ts";
import { shouldLowerLogicalExpression } from "../../../policy/mod.ts";
import { unwrapExpression } from "../../../utils/expression.ts";
import { isFallbackOperator } from "../../../utils/reactive-keys.ts";

/**
 * Check if an expression is JSX (element, fragment, or self-closing).
 * Also handles parenthesized JSX like `(<div>...</div>)`.
 */
function isMapReceiverBinary(expression: ts.BinaryExpression): boolean {
  let current: ts.Node = expression;

  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isPartiallyEmittedExpression(current.parent)
  ) {
    current = current.parent;
  }

  const parent = current.parent;
  return ts.isPropertyAccessExpression(parent) &&
    parent.expression === current &&
    parent.name.text === "map";
}

function canDeferFallbackMapReceiverDerive(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
): boolean {
  if (!isFallbackOperator(expression.operatorToken.kind)) {
    return false;
  }

  const left = unwrapExpression(expression.left);
  return isSimpleOpaqueRefAccess(left, checker);
}

export const emitBinaryExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
  analyze,
  rewriteChildren,
  inSafeContext,
  reactiveContextKind,
  containerKind,
}) => {
  if (!ts.isBinaryExpression(expression)) return undefined;
  const operator = expression.operatorToken.kind;
  const shouldLowerByContextPolicy = shouldLowerLogicalExpression(
    reactiveContextKind,
    containerKind ?? "jsx-expression",
    operator,
  );

  // Check if the left side of && or || has an OpaqueRef type.
  // This is important for cases like `computed(() => plainValue) && <JSX>`
  // where the computed() returns an OpaqueRef but doesn't contain opaques in its inputs.
  // OpaqueRefs are always truthy as objects, so we need when/unless for correct semantics.
  const leftType = context.checker.getTypeAtLocation(expression.left);
  const leftIsOpaqueRef = isOpaqueRefType(leftType, context.checker);

  // Skip if no dataflows AND left side isn't an OpaqueRef type
  if (
    dataFlows.all.length === 0 &&
    !leftIsOpaqueRef &&
    !shouldLowerByContextPolicy
  ) {
    return undefined;
  }

  // Optimize && operator: convert to when instead of wrapping entire expression in derive
  // Example: showPanel && <Panel/>
  // Becomes: when(showPanel, <Panel/>) or when(derive(condition), <Panel/>)
  //
  // The when/unless optimization is beneficial when the right side (value) is expensive
  // to construct, like JSX. This allows short-circuit evaluation to skip constructing
  // the value when the condition is falsy.
  //
  // If the right side is simple (not JSX, no reactive deps), using when/unless is just
  // overhead - better to wrap the whole expression in derive.
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
    if (!shouldLowerByContextPolicy) {
      // Outside pattern context we do not lower && in JSX.
      if (inSafeContext) return undefined;
    }

    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );

    if (shouldLowerByContextPolicy) {
      // Process left side - derive if it has reactive deps, otherwise pass as-is
      let condition: ts.Expression = expression.left;
      if (leftDataFlows.length > 0) {
        if (!isSimpleOpaqueRefAccess(expression.left, context.checker)) {
          const plan = createBindingPlan(leftDataFlows);
          const computedCondition = createComputedCallForExpression(
            expression.left,
            plan,
            context,
          );
          if (computedCondition) {
            condition = computedCondition;
          }
        }
        // If it's a simple opaque ref, pass it directly (no derive needed)
      }

      // Process right side - rewrite children to handle nested opaque refs
      const value = rewriteChildren(expression.right) || expression.right;

      // Create when(condition, value)
      // This is equivalent to: ifElse(condition, value, condition)
      // Preserves && semantics where falsy values are returned as-is
      const whenCall = createWhenCall({
        condition,
        value,
        factory: context.factory,
        ctHelpers: context.ctHelpers,
      });

      // Register the result type for schema injection
      // The result type is the union of condition and value types (from the original && expression)
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

  // Optimize || operator: convert to unless instead of wrapping entire expression in derive
  // Example: value || <Fallback/>
  // Becomes: unless(value, <Fallback/>) or unless(derive(condition), <Fallback/>)
  //
  // Same rationale as &&: only beneficial when right side is expensive.
  if (operator === ts.SyntaxKind.BarBarToken) {
    if (!shouldLowerByContextPolicy) {
      // Outside pattern context we do not lower || in JSX.
      if (inSafeContext) return undefined;
    }

    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );

    if (shouldLowerByContextPolicy) {
      // Process left side - derive if it has reactive deps, otherwise pass as-is
      let condition: ts.Expression = expression.left;
      if (leftDataFlows.length > 0) {
        if (!isSimpleOpaqueRefAccess(expression.left, context.checker)) {
          const plan = createBindingPlan(leftDataFlows);
          const computedCondition = createComputedCallForExpression(
            expression.left,
            plan,
            context,
          );
          if (computedCondition) {
            condition = computedCondition;
          }
        }
        // If it's a simple opaque ref, pass it directly (no derive needed)
      }

      // Process right side - rewrite children to handle nested opaque refs
      const value = rewriteChildren(expression.right) || expression.right;

      // Create unless(condition, value)
      // This is equivalent to: ifElse(condition, condition, value)
      // Preserves || semantics where truthy values are returned as-is
      const unlessCall = createUnlessCall({
        condition,
        value,
        factory: context.factory,
        ctHelpers: context.ctHelpers,
      });

      // Register the result type for schema injection
      // The result type is the union of condition and fallback types (from the original || expression)
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

  // Fallback: wrap entire expression in derive (original behavior)
  // Skip in safe contexts - they don't need derive wrappers, only when/unless
  if (inSafeContext) {
    return undefined;
  }

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  // Keep fallback receiver expressions intact in pattern context so
  // ClosureTransformer can lower `(x ?? y).map(...)` / `(x || y).map(...)`
  // into mapWithPattern with proper capture handling.
  if (
    reactiveContextKind === "pattern" &&
    isMapReceiverBinary(expression) &&
    canDeferFallbackMapReceiverDerive(expression, context.checker)
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

  const plan = createBindingPlan(relevantDataFlows);
  return createComputedCallForExpression(expression, plan, context);
};
