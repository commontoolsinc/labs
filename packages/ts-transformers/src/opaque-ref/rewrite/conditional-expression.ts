import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import { createIfElseCall } from "../transforms.ts";
import { selectDependenciesWithin } from "../normalise.ts";
import { isSimpleOpaqueRefAccess } from "../types.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDependencies,
} from "./helpers.ts";

export const emitConditionalExpression: Emitter = ({
  expression,
  dependencies,
  analysis,
  context,
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;
  if (dependencies.all.length === 0) return undefined;

  const predicateDependencies = selectDependenciesWithin(
    dependencies,
    expression.condition,
  );
  const shouldDerivePredicate = predicateDependencies.length > 0 &&
    !isSimpleOpaqueRefAccess(expression.condition, context.checker);

  const helpers = new Set<OpaqueRefHelperName>(["ifElse"]);
  let predicate: ts.Expression = expression.condition;
  let whenTrue: ts.Expression = expression.whenTrue;
  let whenFalse: ts.Expression = expression.whenFalse;

  if (shouldDerivePredicate) {
    const plan = createBindingPlan(predicateDependencies);
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

  const whenTrueDependencies = filterRelevantDependencies(
    selectDependenciesWithin(dependencies, expression.whenTrue),
    analysis,
    context,
  );
  if (whenTrueDependencies.length > 0) {
    const plan = createBindingPlan(whenTrueDependencies);
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

  const whenFalseDependencies = filterRelevantDependencies(
    selectDependenciesWithin(dependencies, expression.whenFalse),
    analysis,
    context,
  );
  if (whenFalseDependencies.length > 0) {
    const plan = createBindingPlan(whenFalseDependencies);
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
