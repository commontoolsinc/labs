import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
import {
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
import {
  assertValidComputeWrapCandidate,
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
} from "./compute-wrap-invariants.ts";

function processBranch(
  expr: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
  rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"],
): ts.Expression {
  // JSX containers can lower their dynamic slots independently, so the branch
  // does not need a whole-expression compute wrapper just because one child JSX
  // expression needs a local derive.
  if (isJsxLocalRewriteContainer(expr)) {
    return rewriteChildren(expr) || expr;
  }

  // Branch wrapping needs a branch-local view of data flow, so we intentionally
  // re-analyze the authored branch here instead of reusing the outer
  // conditional's aggregate analysis. The important invariant is that the wrap
  // decision still runs on the authored subtree before recursive rewriting;
  // otherwise we start reasoning about a partially lowered branch and can
  // introduce nested derives or mixed pattern/compute lowering.
  const branchAnalysis = analyze(expr);
  const branchDataFlows = filterRelevantDataFlows(
    normalizeDataFlows(
      branchAnalysis.graph,
      branchAnalysis.dataFlows,
    ).all,
    branchAnalysis,
    context,
  );

  const pendingRewrite = branchDataFlows.length > 0
    ? findPendingComputeWrapCandidate(expr, analyze, context)
    : undefined;

  if (pendingRewrite) {
    assertValidComputeWrapCandidate(
      pendingRewrite,
      expr,
      "ternary branch",
      context,
    );

    const plan = createBindingPlan(branchDataFlows);
    const derived = createComputedCallForExpression(expr, plan, context);
    if (derived) {
      return derived;
    }
  }

  return rewriteChildren(expr) || expr;
}

export const emitConditionalExpression: Emitter = ({
  expression,
  dataFlows,
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
