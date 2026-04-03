import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
import {
  isSimpleReactiveAccessExpression,
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import {
  assertValidComputeWrapCandidate,
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
} from "./compute-wrap-invariants.ts";
import { unwrapExpression } from "../../../utils/expression.ts";

function isControlFlowBranchExpression(expr: ts.Expression): boolean {
  const current = unwrapExpression(expr);
  return ts.isConditionalExpression(current) ||
    (
      ts.isBinaryExpression(current) &&
      (
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken
      )
    );
}

function isLogicalControlFlowExpression(expr: ts.Expression): boolean {
  const current = unwrapExpression(expr);
  return ts.isBinaryExpression(current) &&
    (
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken
    );
}

function processBranch(
  expr: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
  rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"],
  rewriteSubexpression: Parameters<Emitter>[0]["rewriteSubexpression"],
  preferDeriveWrappers: boolean,
): ts.Expression {
  if (isJsxLocalRewriteContainer(expr)) {
    return rewriteChildren(expr) || expr;
  }

  if (isControlFlowBranchExpression(expr)) {
    return rewriteSubexpression(expr) || expr;
  }

  const branchAnalysis = analyze(expr);
  const branchDataFlows = context.getRelevantDataFlowsFromAnalysis(
    branchAnalysis,
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

    const derived = createReactiveWrapperForExpression(
      expr,
      branchDataFlows,
      context,
      {
        preferDeriveWrapper: preferDeriveWrappers,
      },
    );
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
  rewriteSubexpression,
  inSafeContext,
  preferDeriveWrappers,
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;

  if (inSafeContext) return undefined;
  if (dataFlows.length === 0) return undefined;

  const predicateDataFlows = selectDataFlowsReferencedIn(
    dataFlows,
    expression.condition,
  );
  const shouldDerivePredicate = predicateDataFlows.length > 0 &&
    !isSimpleReactiveAccessExpression(expression.condition, context.checker);

  let predicate: ts.Expression = expression.condition;
  if (isLogicalControlFlowExpression(expression.condition)) {
    predicate = rewriteSubexpression(expression.condition);
  } else if (shouldDerivePredicate) {
    const derivedPredicate = createReactiveWrapperForExpression(
      expression.condition,
      predicateDataFlows,
      context,
      { preferDeriveWrapper: preferDeriveWrappers },
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
    rewriteSubexpression,
    preferDeriveWrappers,
  );

  const whenFalse = processBranch(
    expression.whenFalse,
    context,
    analyze,
    rewriteChildren,
    rewriteSubexpression,
    preferDeriveWrappers,
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
