import ts from "typescript";

import type { EmitterContext } from "../types.ts";

const isContainerExpression = (expression: ts.Expression): boolean => {
  return ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression);
};

export const emitContainerExpression = ({
  expression,
  rewriteChildren,
}: EmitterContext) => {
  if (!isContainerExpression(expression)) return undefined;
  return rewriteChildren(expression);
};
