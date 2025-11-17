import ts from "typescript";

/**
 * Checks if an expression is a function expression (arrow or function expression).
 * Use this for checking callback arguments in builder calls.
 */
export function isFunctionLikeExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}
