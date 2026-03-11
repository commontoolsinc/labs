import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
import {
  detectCallKind,
  normalizeDataFlows,
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { isSimpleOpaqueRefAccess } from "../opaque-ref.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

function branchHasPendingRewrite(
  expr: ts.Expression,
  analyze: Parameters<Emitter>[0]["analyze"],
  context: Parameters<Emitter>[0]["context"],
): boolean {
  let pending = false;

  const visit = (node: ts.Node): void => {
    if (pending) return;

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // Nested callbacks establish their own rewrite boundaries.
      return;
    }

    if (!ts.isExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (isSimpleOpaqueRefAccess(node, context.checker)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (
      ts.isParenthesizedExpression(node) ||
      ts.isJsxExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxSelfClosingElement(node)
    ) {
      ts.forEachChild(node, visit);
      return;
    }

    const nodeAnalysis = analyze(node);
    if (!nodeAnalysis.containsOpaqueRef || !nodeAnalysis.requiresRewrite) {
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, context.checker);
      if (
        callKind?.kind === "array-method" ||
        callKind?.kind === "derive" ||
        callKind?.kind === "ifElse" ||
        callKind?.kind === "when" ||
        callKind?.kind === "unless" ||
        callKind?.kind === "builder"
      ) {
        return;
      }
    }

    pending = true;
  };

  visit(expr);
  return pending;
}

// Helper to process a conditional branch (whenTrue/whenFalse)
function processBranch(
  expr: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
  rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"],
): ts.Expression {
  const rewritten = rewriteChildren(expr) || expr;
  const rewrittenAnalysis = analyze(rewritten);
  const rewrittenDataFlows = filterRelevantDataFlows(
    normalizeDataFlows(
      rewrittenAnalysis.graph,
      rewrittenAnalysis.dataFlows,
    ).all,
    rewrittenAnalysis,
    context,
  );

  if (
    rewrittenDataFlows.length > 0 &&
    branchHasPendingRewrite(rewritten, analyze, context)
  ) {
    const plan = createBindingPlan(rewrittenDataFlows);
    const derived = createComputedCallForExpression(rewritten, plan, context);
    if (derived) {
      return derived;
    }
  }

  return rewritten;
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
    context,
    analyze,
    rewriteChildren,
  );

  const whenFalse = processBranch(
    expression.whenFalse,
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
