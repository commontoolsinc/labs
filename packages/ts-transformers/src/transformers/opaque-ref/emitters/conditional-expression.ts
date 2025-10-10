import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
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
  analyze,
  rewriteChildren,
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  const predicateDataFlows = selectDataFlowsWithin(
    dataFlows,
    expression.condition,
  );
  const shouldDerivePredicate = predicateDataFlows.length > 0 &&
    !isSimpleOpaqueRefAccess(expression.condition, context.checker);

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
    if (derivedPredicate) {
      predicate = derivedPredicate;
    }
  }

  const whenTrueDataFlows = filterRelevantDataFlows(
    selectDataFlowsWithin(dataFlows, expression.whenTrue),
    analysis,
    context,
  );

  // Check if the whenTrue branch actually requires rewriting
  const whenTrueAnalysis = analyze(expression.whenTrue);

  if (whenTrueDataFlows.length > 0 && whenTrueAnalysis.requiresRewrite) {
    const plan = createBindingPlan(whenTrueDataFlows);
    const derivedWhenTrue = createDeriveCallForExpression(
      expression.whenTrue,
      plan,
      context,
    );
    if (derivedWhenTrue) {
      whenTrue = derivedWhenTrue;
    } else {
      const rewritten = rewriteChildren(expression.whenTrue);
      if (rewritten) {
        whenTrue = rewritten;
      }
    }
  } else {
    const rewritten = rewriteChildren(expression.whenTrue);
    if (rewritten) {
      whenTrue = rewritten;
    }
  }

  const whenFalseDataFlows = filterRelevantDataFlows(
    selectDataFlowsWithin(dataFlows, expression.whenFalse),
    analysis,
    context,
  );

  // Check if the whenFalse branch actually requires rewriting
  const whenFalseAnalysis = analyze(expression.whenFalse);

  if (whenFalseDataFlows.length > 0 && whenFalseAnalysis.requiresRewrite) {
    const plan = createBindingPlan(whenFalseDataFlows);
    const derivedWhenFalse = createDeriveCallForExpression(
      expression.whenFalse,
      plan,
      context,
    );
    if (derivedWhenFalse) {
      whenFalse = derivedWhenFalse;
    } else {
      const rewritten = rewriteChildren(expression.whenFalse);
      if (rewritten) {
        whenFalse = rewritten;
      }
    }
  } else {
    const rewritten = rewriteChildren(expression.whenFalse);
    if (rewritten) {
      whenFalse = rewritten;
    }
  }

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
