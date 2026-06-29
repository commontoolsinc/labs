import ts from "typescript";
import type { Emitter } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import { createExprLiftCall } from "../../builtins/expr-lift.ts";
import { SUPPORTED_EXPR_UNARY_OPERATORS } from "../../../policy/mod.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  inSafeContext,
  preferInputBoundWrappers,
  rewriteSubexpression,
}) => {
  if (!ts.isPrefixUnaryExpression(expression)) return undefined;

  // Skip lift-applied wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  // Today only `!` reaches the wrapper (the other unary operators fall through
  // to the enclosing-site wrapper). The expr-op allow-list covers `!`/`-`/`+`/`~`
  // (NOT `typeof`, excluded per E-3); branding here ADDS native coverage for the
  // operators that have a dedicated emitter without changing the un-branded path.
  const exprBrand = SUPPORTED_EXPR_UNARY_OPERATORS.get(expression.operator);
  if (exprBrand === undefined) {
    // Preserve the historical behavior: only `!` was wrapped here; a non-`!`
    // unary with no dedicated emitter falls through unchanged. (The allow-list
    // currently includes only operators we natively interpret; a future operator
    // not in it must keep falling through.)
    if (expression.operator !== ts.SyntaxKind.ExclamationToken) {
      return undefined;
    }
  }
  if (dataFlows.length === 0) return undefined;

  // BRANDED EXPR-OP LOWERING (08-expression-interpretation §2/§3). Emit a branded
  // `exprLift` whose single POSITIONAL operand is the rewritten operand sub-
  // expression, so the reactive interpreter lowers it to a native unary `expr`
  // op while legacy runs the identical operator body. Gated by the allow-list +
  // `lowerExprOps !== false` (default ON); any miss falls through to the existing
  // un-branded wrapper UNCHANGED.
  if (exprBrand !== undefined && context.options.lowerExprOps !== false) {
    const operand = rewriteSubexpression(expression.operand);
    return createExprLiftCall(
      expression,
      `expr:${exprBrand}`,
      expression.operator,
      true,
      [operand],
      context,
    );
  }

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
};
