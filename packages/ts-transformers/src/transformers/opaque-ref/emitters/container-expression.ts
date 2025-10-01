import ts from "typescript";

import type { Emitter } from "../types.ts";

const isContainerExpression = (expression: ts.Expression): boolean => {
  return ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression);
};

export const emitContainerExpression: Emitter = ({
  expression,
  context,
}) => {
  if (!isContainerExpression(expression)) return undefined;
  const rewritten = context.rewriteChildren(expression);
  if (rewritten === expression) return undefined;
  return {
    expression: rewritten,
    helpers: new Set(),
  };
};
