import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import { createIfElseCall } from "../transforms.ts";
import { selectDependenciesWithin } from "../normalise.ts";
import { isSimpleOpaqueRefAccess } from "../types.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import { createDeriveCallForExpression } from "./helpers.ts";

export const emitConditionalExpression: Emitter = ({
  expression,
  dependencies,
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

  if (shouldDerivePredicate) {
    const plan = createBindingPlan(predicateDependencies);
    predicate = createDeriveCallForExpression(
      expression.condition,
      plan,
      context,
    );
    helpers.add("derive");
  }

  const rewritten = createIfElseCall(
    expression,
    context.factory,
    context.sourceFile,
    { predicate },
  );

  return {
    expression: rewritten,
    helpers,
  };
};
