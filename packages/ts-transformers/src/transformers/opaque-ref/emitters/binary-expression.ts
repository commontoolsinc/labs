import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { createUnlessCall, createWhenCall } from "../../builtins/ifelse.ts";
import {
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { isOpaqueRefType, isSimpleOpaqueRefAccess } from "../opaque-ref.ts";

/**
 * Check if an expression is JSX (element, fragment, or self-closing).
 * Also handles parenthesized JSX like `(<div>...</div>)`.
 */
function isJsxExpression(expr: ts.Expression): boolean {
  // Unwrap parentheses
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  return ts.isJsxElement(expr) ||
    ts.isJsxFragment(expr) ||
    ts.isJsxSelfClosingElement(expr);
}

export const emitBinaryExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
  rewriteChildren,
  inSafeContext,
}) => {
  if (!ts.isBinaryExpression(expression)) return undefined;

  // Check if the left side of && or || has an OpaqueRef type.
  // This is important for cases like `computed(() => plainValue) && <JSX>`
  // where the computed() returns an OpaqueRef but doesn't contain opaques in its inputs.
  // OpaqueRefs are always truthy as objects, so we need when/unless for correct semantics.
  const leftType = context.checker.getTypeAtLocation(expression.left);
  const leftIsOpaqueRef = isOpaqueRefType(leftType, context.checker);

  // Skip if no dataflows AND left side isn't an OpaqueRef type
  if (dataFlows.all.length === 0 && !leftIsOpaqueRef) return undefined;

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
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );
    const rightDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.right,
    );

    // Check if right side is "expensive" - JSX or has reactive dependencies that need derive
    const rightIsJsx = isJsxExpression(expression.right);
    const rightNeedsDerive = rightDataFlows.length > 0 &&
      !isSimpleOpaqueRefAccess(expression.right, context.checker);
    const rightIsExpensive = rightIsJsx || rightNeedsDerive;

    // Use when() transformation if:
    // 1. Right side is expensive (JSX or needs derive) - original optimization
    // 2. OR left side is an OpaqueRef type - needed because OpaqueRefs are always truthy objects
    //    so `computed(...) && <JSX>` would always render without when()
    if (rightIsExpensive || leftIsOpaqueRef) {
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
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const leftDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.left,
    );
    const rightDataFlows = selectDataFlowsReferencedIn(
      dataFlows,
      expression.right,
    );

    // Check if right side is "expensive" - JSX or has reactive dependencies that need derive
    const rightIsJsx = isJsxExpression(expression.right);
    const rightNeedsDerive = rightDataFlows.length > 0 &&
      !isSimpleOpaqueRefAccess(expression.right, context.checker);
    const rightIsExpensive = rightIsJsx || rightNeedsDerive;

    // Use unless() transformation if:
    // 1. Right side is expensive (JSX or needs derive) - original optimization
    // 2. OR left side is an OpaqueRef type - needed because OpaqueRefs are always truthy objects
    //    so `computed(...) || <Fallback>` would never render fallback without unless()
    if (rightIsExpensive || leftIsOpaqueRef) {
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

  const plan = createBindingPlan(relevantDataFlows);
  return createComputedCallForExpression(expression, plan, context);
};
