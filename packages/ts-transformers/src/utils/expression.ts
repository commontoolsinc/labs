import ts from "typescript";

interface UnwrapExpressionOptions {
  readonly includePartiallyEmitted?: boolean;
}

/**
 * Removes non-semantic wrappers around expressions.
 */
export function unwrapExpression(
  expr: ts.Expression,
  options: UnwrapExpressionOptions = {},
): ts.Expression {
  const includePartiallyEmitted = options.includePartiallyEmitted ?? true;
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (includePartiallyEmitted && ts.isPartiallyEmittedExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}
