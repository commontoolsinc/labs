import ts from "typescript";

import { CF_HELPERS_IDENTIFIER } from "../core/cf-helpers.ts";

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

/**
 * The runtime helper an `assert` body records an operand with. It takes the
 * operand and hands the same value back.
 */
export const ASSERT_CAPTURE_HELPER_NAME = "assertCapture";

/** The `assertCapture` argument holding the operand. */
const ASSERT_CAPTURE_VALUE_ARGUMENT = 2;

/** True for a `__cfHelpers.assertCapture(parts, src, value)` call. */
function isAssertCaptureCall(
  expression: ts.Expression,
): expression is ts.CallExpression {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  return ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === CF_HELPERS_IDENTIFIER &&
    callee.name.text === ASSERT_CAPTURE_HELPER_NAME &&
    expression.arguments.length === ASSERT_CAPTURE_VALUE_ARGUMENT + 1;
}

/**
 * The expression a value comes from, with the operand recordings an `assert`
 * body puts in the way removed. It also removes everything
 * {@link unwrapExpression} removes.
 *
 * `AssertDiagnosticsTransformer` rewrites `event.details.includes(text)` into
 * `__cfHelpers.assertCapture(parts, "event.details", event.details)
 * .includes(text)`. The method is now called on a call rather than on the
 * member access the author wrote. An analysis asking which reactive value an
 * expression reads has to read through that call to reach `event.details`.
 * Without it the read goes unrecorded, and the field is projected out of the
 * schema the body is served.
 */
export function unwrapAssertCapture(expression: ts.Expression): ts.Expression {
  let current = unwrapExpression(expression);
  while (isAssertCaptureCall(current)) {
    current = unwrapExpression(
      current.arguments[ASSERT_CAPTURE_VALUE_ARGUMENT]!,
    );
  }
  return current;
}
