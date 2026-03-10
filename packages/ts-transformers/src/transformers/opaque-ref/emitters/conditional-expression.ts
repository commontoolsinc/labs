import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
import {
  isReactiveArrayMapCall,
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import type { NormalizedDataFlowSet } from "../../../ast/mod.ts";
import { isSimpleOpaqueRefAccess } from "../opaque-ref.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

// Helper to process a conditional branch (whenTrue/whenFalse)
function processBranch(
  expr: ts.Expression,
  dataFlows: NormalizedDataFlowSet,
  analysis: ReturnType<Parameters<Emitter>[0]["analyze"]>,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
  rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"],
): ts.Expression {
  const branchDataFlows = filterRelevantDataFlows(
    selectDataFlowsReferencedIn(dataFlows, expr),
    analysis,
    context,
  );

  const branchAnalysis = analyze(expr);

  // Skip derive wrapping for reactive array map calls - they will be transformed
  // to mapWithPattern by ClosureTransformer, which is already reactive.
  // Wrapping in derive would incorrectly put the map callback in a "safe context",
  // which would prevent nested maps from being transformed to mapWithPattern.
  // Note: We need to unwrap parenthesized expressions to find the actual call.
  let unwrappedExpr: ts.Expression = expr;
  while (ts.isParenthesizedExpression(unwrappedExpr)) {
    unwrappedExpr = unwrappedExpr.expression;
  }
  const isReactiveMap = ts.isCallExpression(unwrappedExpr) &&
    isReactiveArrayMapCall(
      unwrappedExpr,
      context.checker,
      context.options.typeRegistry,
      context.options.logger,
    );

  if (
    branchDataFlows.length > 0 &&
    branchAnalysis.requiresRewrite &&
    !isSimpleOpaqueRefAccess(expr, context.checker) &&
    !isReactiveMap
  ) {
    const plan = createBindingPlan(branchDataFlows);
    const derived = createComputedCallForExpression(expr, plan, context);
    if (derived) {
      return derived;
    }
  }

  // Fallback: rewrite children
  const rewritten = rewriteChildren(expr);
  return rewritten || expr;
}

export const emitConditionalExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
  analyze,
  rewriteChildren,
  inSafeContext,
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;

  // Skip ternary transformation in safe contexts - they don't need ifElse wrapping
  if (inSafeContext) return undefined;

  if (dataFlows.all.length === 0) return undefined;

  const predicateDataFlows = selectDataFlowsReferencedIn(
    dataFlows,
    expression.condition,
  );
  const shouldDerivePredicate = predicateDataFlows.length > 0 &&
    !isSimpleOpaqueRefAccess(expression.condition, context.checker);

  let predicate: ts.Expression = expression.condition;
  if (shouldDerivePredicate) {
    const plan = createBindingPlan(predicateDataFlows);
    const derivedPredicate = createComputedCallForExpression(
      expression.condition,
      plan,
      context,
    );
    if (derivedPredicate) {
      predicate = derivedPredicate;
    }
  }

  const whenTrue = processBranch(
    expression.whenTrue,
    dataFlows,
    analysis,
    context,
    analyze,
    rewriteChildren,
  );

  const whenFalse = processBranch(
    expression.whenFalse,
    dataFlows,
    analysis,
    context,
    analyze,
    rewriteChildren,
  );

  const ifElseCall = createIfElseCall({
    expression,
    factory: context.factory,
    ctHelpers: context.ctHelpers,
    sourceFile: context.sourceFile,
    overrides: {
      predicate,
      whenTrue,
      whenFalse,
    },
  });

  // Register the result type for schema injection
  // The result type is the union of whenTrue and whenFalse types (from the original ternary)
  if (context.options.typeRegistry) {
    const resultType = context.checker.getTypeAtLocation(expression);
    registerSyntheticCallType(
      ifElseCall,
      resultType,
      context.options.typeRegistry,
    );
  }

  return ifElseCall;
};
