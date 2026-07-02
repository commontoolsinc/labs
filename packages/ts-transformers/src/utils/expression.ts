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

/**
 * True for the syntactic shapes that compute a *value* from their operands —
 * binary (`a === b`, `a + b`, `a ?? b`), prefix/postfix unary (`!x`, `-x`,
 * `x++`), and conditional (`a ? b : c`). These are the expressions a reactive
 * boundary (a helper body, or a map/filter/flatMap callback) lifts to value
 * level so they operate on resolved values rather than Reactive proxies.
 *
 * It is a purely syntactic kind check — it does NOT decide lowerability
 * (reactivity, control-flow routing, and collection-vs-value distinctions are
 * the caller's concern). Conditionals and logical `&&`/`||` are included here
 * but are typically peeled off earlier by control-flow lowering.
 */
export function isValueComputationExpressionKind(
  expression: ts.Expression,
): boolean {
  return ts.isBinaryExpression(expression) ||
    ts.isPrefixUnaryExpression(expression) ||
    ts.isPostfixUnaryExpression(expression) ||
    ts.isConditionalExpression(expression);
}
