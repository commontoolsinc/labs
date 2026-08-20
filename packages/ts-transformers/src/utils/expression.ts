import ts from "typescript";

/**
 * The expression forms that wrap an inner expression without changing the
 * value it denotes: `(x)`, `x as T`, `<T>x`, `x satisfies T`, `x!`, and the
 * partially emitted node that carries an already-rewritten subtree.
 *
 * This is the one set the pipeline looks through, and it is read in three
 * forms so that every shape of consumer has a definition to reach for:
 * {@link isTransparentWrapper} tests a node, {@link unwrapTransparentWrapperOnce}
 * steps through a single wrapper, and {@link unwrapExpression} reaches the
 * innermost expression. A spelling added here reaches all three at once, so a
 * wrapper cannot be handled by one resolver and missed by another.
 *
 * A stripper that reads a narrower set does so deliberately, and says why at
 * its own definition.
 */
export type TransparentWrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.PartiallyEmittedExpression;

/**
 * True for a node that wraps an inner expression without changing the value it
 * denotes.
 */
export function isTransparentWrapper(
  node: ts.Node,
): node is TransparentWrapper {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isPartiallyEmittedExpression(node);
}

/**
 * The expression a single transparent wrapper wraps, or `undefined` when the
 * node is not one.
 *
 * This is the form for a caller that walks a wrapper chain a node at a time:
 * one following parent links outward, or one that must know which side of a
 * wrapper it arrived from. A caller that only wants the innermost expression
 * uses {@link unwrapExpression}.
 */
export function unwrapTransparentWrapperOnce(
  node: ts.Node,
): ts.Expression | undefined {
  return isTransparentWrapper(node) ? node.expression : undefined;
}

/**
 * The innermost expression, reached by removing every transparent wrapper.
 */
export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (isTransparentWrapper(current)) {
    current = current.expression;
  }
  return current;
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
