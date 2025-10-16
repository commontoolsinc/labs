import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
import { getExpressionText, selectDataFlowsWithin } from "../../../ast/mod.ts";
import type { NormalizedDataFlowSet } from "../../../ast/mod.ts";
import { isSimpleOpaqueRefAccess } from "../opaque-ref.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

// Helper to find data flows that are referenced in an expression
// This is needed for parameters which don't have positional occurrences within the expression
function selectDataFlowsReferencedIn(
  set: NormalizedDataFlowSet,
  node: ts.Node,
): typeof set.all {
  const referencedExpressions = new Set<string>();

  // Find all expressions used in the node
  const visit = (n: ts.Node) => {
    if (ts.isExpression(n)) {
      referencedExpressions.add(getExpressionText(n));
    }
    ts.forEachChild(n, visit);
  };
  visit(node);

  // Return data flows whose expression text matches any referenced expression
  return set.all.filter((dataFlow) => {
    const flowExprText = getExpressionText(dataFlow.expression);
    return referencedExpressions.has(flowExprText);
  });
}

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

  if (
    branchDataFlows.length > 0 &&
    branchAnalysis.requiresRewrite &&
    !isSimpleOpaqueRefAccess(expr, context.checker)
  ) {
    const plan = createBindingPlan(branchDataFlows);
    const derived = createDeriveCallForExpression(expr, plan, context);
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
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;
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
    const derivedPredicate = createDeriveCallForExpression(
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

  return createIfElseCall({
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
};
