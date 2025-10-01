import ts from "typescript";

import type { Emitter, OpaqueRefHelperName } from "../types.ts";
import { createIfElseCall } from "../builtins.ts";
import { selectDataFlowsWithin } from "../../../ast/mod.ts";
import { isSimpleOpaqueRefAccess } from "../opaque-ref.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

export const emitConditionalExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  const predicateDataFlows = selectDataFlowsWithin(
    dataFlows,
    expression.condition,
  );
  const shouldDerivePredicate = predicateDataFlows.length > 0 &&
    !isSimpleOpaqueRefAccess(expression.condition, context.checker);

  const helpers = new Set<OpaqueRefHelperName>(["ifElse"]);
  let predicate: ts.Expression = expression.condition;
  let whenTrue: ts.Expression = expression.whenTrue;
  let whenFalse: ts.Expression = expression.whenFalse;

  if (shouldDerivePredicate) {
    const plan = createBindingPlan(predicateDataFlows);
    const derivedPredicate = createDeriveCallForExpression(
      expression.condition,
      plan,
      context,
    );
    if (derivedPredicate !== expression.condition) {
      predicate = derivedPredicate;
      helpers.add("derive");
    }
  }

  const whenTrueDataFlows = filterRelevantDataFlows(
    selectDataFlowsWithin(dataFlows, expression.whenTrue),
    analysis,
    context,
  );

  // Check if the whenTrue branch actually requires rewriting
  const whenTrueAnalysis = context.analyze(expression.whenTrue);

  if (whenTrueDataFlows.length > 0 && whenTrueAnalysis.requiresRewrite) {
    const plan = createBindingPlan(whenTrueDataFlows);
    const derivedWhenTrue = createDeriveCallForExpression(
      expression.whenTrue,
      plan,
      context,
    );
    if (derivedWhenTrue !== expression.whenTrue) {
      whenTrue = derivedWhenTrue;
      helpers.add("derive");
    } else {
      const rewritten = context.rewriteChildren(expression.whenTrue);
      if (rewritten !== expression.whenTrue) whenTrue = rewritten;
    }
  } else {
    const rewritten = context.rewriteChildren(expression.whenTrue);
    if (rewritten !== expression.whenTrue) whenTrue = rewritten;
  }

  const whenFalseDataFlows = filterRelevantDataFlows(
    selectDataFlowsWithin(dataFlows, expression.whenFalse),
    analysis,
    context,
  );

  // Check if the whenFalse branch actually requires rewriting
  const whenFalseAnalysis = context.analyze(expression.whenFalse);

  if (whenFalseDataFlows.length > 0 && whenFalseAnalysis.requiresRewrite) {
    const plan = createBindingPlan(whenFalseDataFlows);
    const derivedWhenFalse = createDeriveCallForExpression(
      expression.whenFalse,
      plan,
      context,
    );
    if (derivedWhenFalse !== expression.whenFalse) {
      whenFalse = derivedWhenFalse;
      helpers.add("derive");
    } else {
      const rewritten = context.rewriteChildren(expression.whenFalse);
      if (rewritten !== expression.whenFalse) whenFalse = rewritten;
    }
  } else {
    const rewritten = context.rewriteChildren(expression.whenFalse);
    if (rewritten !== expression.whenFalse) whenFalse = rewritten;
  }

  const rewritten = createIfElseCall(
    expression,
    context.factory,
    context.sourceFile,
    {
      predicate,
      whenTrue,
      whenFalse,
    },
  );

  return {
    expression: rewritten,
    helpers,
  };
};
