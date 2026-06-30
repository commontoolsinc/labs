import ts from "typescript";

import { classifyArrayMethodAccess } from "../../ast/mod.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import { isFallbackOperator } from "../../utils/reactive-keys.ts";
import { isSimpleReactiveAccess } from "../cell-type.ts";

export function isFallbackMapReceiverExpression(
  expression: ts.BinaryExpression,
): boolean {
  let current: ts.Node = expression;

  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isPartiallyEmittedExpression(current.parent)
  ) {
    current = current.parent;
  }

  const parent = current.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== current) {
    return false;
  }

  const arrayMethodInfo = classifyArrayMethodAccess(parent);
  return !!arrayMethodInfo &&
    !arrayMethodInfo.lowered &&
    arrayMethodInfo.family === "map";
}

export function shouldDeferFallbackMapReceiverRewrite(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
): boolean {
  if (!isFallbackOperator(expression.operatorToken.kind)) {
    return false;
  }

  if (!isFallbackMapReceiverExpression(expression)) {
    return false;
  }

  return isSimpleReactiveAccess(unwrapExpression(expression.left), checker);
}
