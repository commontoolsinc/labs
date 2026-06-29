import ts from "typescript";
import {
  getCellKind,
  isBrandedCellType,
} from "../transformers/opaque-ref/opaque-ref.ts";
import { isReactiveValueExpression } from "../ast/call-kind.ts";
import type { ReactiveContextKind } from "../ast/reactive-context.ts";
import type { ExpressionContainerKind } from "../transformers/expression-site-types.ts";

export type ReactiveReceiverKind =
  | "plain"
  | "opaque_autounwrapped"
  | "celllike_requires_rewrite";

export function classifyReactiveReceiverKind(
  expression: ts.Expression,
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): ReactiveReceiverKind {
  if (type && isBrandedCellType(type, checker)) {
    const kind = getCellKind(type, checker);
    if (kind === "cell" || kind === "stream") {
      return "celllike_requires_rewrite";
    }

    // Opaque values auto-unwrap in compute callbacks.
    return "opaque_autounwrapped";
  }

  return isReactiveValueExpression(expression, checker)
    ? "opaque_autounwrapped"
    : "plain";
}

export function shouldLowerLogicalExpression(
  contextKind: ReactiveContextKind,
  _containerKind: ExpressionContainerKind,
  operator: ts.SyntaxKind,
): boolean {
  if (
    operator !== ts.SyntaxKind.AmpersandAmpersandToken &&
    operator !== ts.SyntaxKind.BarBarToken
  ) {
    return false;
  }

  // Policy: lower always in pattern-owned expression sites, never in compute/neutral sites.
  return contextKind === "pattern";
}

/**
 * The CLOSED allow-list mapping a TypeScript binary-operator `SyntaxKind` to its
 * native `expr`-op token (08-expression-interpretation §2/§3, the fail-closed
 * E-2 gate). ONLY a token in this map is branded as an `expr` lift the reactive
 * interpreter lowers natively; everything else (logical `&&`/`||`, `??`, `in`,
 * `instanceof`, comma, assignment, anything new) emits the ordinary un-branded
 * lift exactly as today — so a half-supported / unknown operator degrades to a
 * leaf, NEVER a wrong op. This is provably ⊆ the runtime `ExprOp` allow-list
 * (rog.ts `EXPR_BIN_OPS`): the strings here are exactly its binary members.
 *
 * Logical `&&`/`||` are DELIBERATELY EXCLUDED — they keep their existing
 * `when`/`unless` builtin lowering, which already interprets natively as a
 * `control` op with the exact operand-return + short-circuit semantics (OQ-E3).
 */
export const SUPPORTED_EXPR_BINARY_OPERATORS: ReadonlyMap<
  ts.SyntaxKind,
  string
> = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.PlusToken, "+"],
  [ts.SyntaxKind.MinusToken, "-"],
  [ts.SyntaxKind.AsteriskToken, "*"],
  [ts.SyntaxKind.SlashToken, "/"],
  [ts.SyntaxKind.PercentToken, "%"],
  [ts.SyntaxKind.AsteriskAsteriskToken, "**"],
  [ts.SyntaxKind.AmpersandToken, "&"],
  [ts.SyntaxKind.BarToken, "|"],
  [ts.SyntaxKind.CaretToken, "^"],
  [ts.SyntaxKind.LessThanLessThanToken, "<<"],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, ">>"],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, ">>>"],
  [ts.SyntaxKind.LessThanToken, "<"],
  [ts.SyntaxKind.GreaterThanToken, ">"],
  [ts.SyntaxKind.LessThanEqualsToken, "<="],
  [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
  [ts.SyntaxKind.EqualsEqualsToken, "=="],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "==="],
  [ts.SyntaxKind.ExclamationEqualsToken, "!="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!=="],
]);

/**
 * The CLOSED allow-list mapping a TypeScript PREFIX-UNARY-operator `SyntaxKind`
 * to its native `expr`-op token (`u`-prefixed to disambiguate from the binary
 * `-`/`+`). `typeof` is DELIBERATELY EXCLUDED from v1 (review E-3): it clashes
 * with the evaluator's `undefined`-on-unresolved convention. Provably ⊆ the
 * runtime `EXPR_UN_OPS` allow-list.
 */
export const SUPPORTED_EXPR_UNARY_OPERATORS: ReadonlyMap<
  ts.SyntaxKind,
  string
> = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.MinusToken, "u-"],
  [ts.SyntaxKind.PlusToken, "u+"],
  [ts.SyntaxKind.TildeToken, "u~"],
  [ts.SyntaxKind.ExclamationToken, "u!"],
]);

export function shouldRewriteCollectionMethod(
  contextKind: ReactiveContextKind,
  methodName: string,
  receiverKind: ReactiveReceiverKind,
): boolean {
  if (
    methodName !== "map" && methodName !== "filter" && methodName !== "flatMap"
  ) {
    return false;
  }

  if (receiverKind === "plain") {
    return false;
  }

  if (contextKind === "pattern") {
    return true;
  }

  if (contextKind === "compute") {
    return receiverKind === "celllike_requires_rewrite";
  }

  return false;
}
