import ts from "typescript";

/**
 * Unwrap an arrow function from parenthesized expressions.
 */
export function unwrapArrowFunction(
  expression: ts.Expression,
): ts.ArrowFunction | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  if (ts.isArrowFunction(current)) {
    return current;
  }
  return undefined;
}
