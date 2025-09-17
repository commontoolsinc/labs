import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDependencies,
} from "./helpers.ts";
import { selectDependenciesWithin } from "../normalise.ts";

export const emitCallExpression: Emitter = ({
  expression,
  dependencies,
  context,
  analysis,
}) => {
  if (!ts.isCallExpression(expression)) return undefined;
  if (dependencies.all.length === 0) return undefined;

  const hint = analysis.rewriteHint;

  if (hint?.kind === "skip-call-rewrite") {
    return undefined;
  }

  if (hint?.kind === "call-if-else") {
    const helpers = new Set<OpaqueRefHelperName>();

    const predicateDependencies = selectDependenciesWithin(
      dependencies,
      hint.predicate,
    );
    const relevantPredicateDependencies = filterRelevantDependencies(
      predicateDependencies,
      analysis,
      context,
    );

    let rewrittenPredicate: ts.Expression = hint.predicate;
    if (relevantPredicateDependencies.length > 0) {
      const plan = createBindingPlan(relevantPredicateDependencies);
      rewrittenPredicate = createDeriveCallForExpression(
        hint.predicate,
        plan,
        context,
      );
      helpers.add("derive");
    } else {
      const child = context.rewriteChildren(hint.predicate);
      if (child !== hint.predicate) {
        rewrittenPredicate = child;
      }
    }

    const rewrittenCallee = context.rewriteChildren(expression.expression);
    const rewrittenArgs: ts.Expression[] = [];
    let changed = rewrittenCallee !== expression.expression;

    expression.arguments.forEach((argument, index) => {
      let updated: ts.Expression = argument;
      if (index === 0) {
        updated = rewrittenPredicate;
      } else {
        const child = context.rewriteChildren(argument);
        if (child !== argument) {
          updated = child;
        }
      }
      if (updated !== argument) changed = true;
      rewrittenArgs.push(updated);
    });

    if (!changed) return undefined;

    const updatedCall = context.factory.updateCallExpression(
      expression,
      rewrittenCallee,
      expression.typeArguments,
      rewrittenArgs,
    );

    return {
      expression: updatedCall,
      helpers,
    };
  }

  const relevantDependencies = filterRelevantDependencies(
    dependencies.all,
    analysis,
    context,
  );
  if (relevantDependencies.length === 0) return undefined;

  const plan = createBindingPlan(relevantDependencies);
  const rewritten = createDeriveCallForExpression(expression, plan, context);

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
};
