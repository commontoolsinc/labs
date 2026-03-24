import ts from "typescript";

import { unwrapExpression } from "../../utils/expression.ts";
import { isFallbackOperator } from "../../utils/reactive-keys.ts";
import { isSimpleOpaqueRefAccess } from "./opaque-ref.ts";

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
  return ts.isPropertyAccessExpression(parent) &&
    parent.expression === current &&
    parent.name.text === "map";
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

  return isSimpleOpaqueRefAccess(unwrapExpression(expression.left), checker);
}
