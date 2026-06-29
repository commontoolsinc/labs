import ts from "typescript";
import {
  getTypeAtLocationWithFallback,
  setParentPointers,
  typeToTypeNodeWithRegistry,
} from "../../ast/mod.ts";
import { registerLiftAppliedCallType } from "../../ast/type-inference.ts";
import { reserveIdentifier } from "../../utils/identifiers.ts";
import type { TransformationContext } from "../../core/mod.ts";

/**
 * Emit a BRANDED operator-expression lift for a recognized arithmetic /
 * comparison / unary operator (08-expression-interpretation §2/§3):
 *
 *   binary `a <op> b` →
 *     __cfHelpers.exprLift("expr:<op>", ([__a, __b]) => __a <op> __b)([a, b])
 *   unary `<op> a` →
 *     __cfHelpers.exprLift("expr:u<op>", ([__a]) => <op>__a)([a])
 *
 * The operands ride POSITIONALLY in a 2-/1-element array applied input, and the
 * arrow body destructures them positionally and applies the LITERAL operator
 * token. This is the same `type:"javascript"` lift module `lift(...)` would
 * build (same runnable body, modulo positional-vs-object input) — so UNDER
 * FLAG-OFF legacy runs the identical operator over the identical resolved
 * operands, BYTE-FOR-BYTE the value the un-branded lift would compute — but the
 * `exprLift` builder stamps `$builtin: "expr:<op>"` so UNDER FLAG-ON the reactive
 * interpreter lowers it to a native `expr` op (no SES round-trip;
 * `recognizeExprLeaf` in runner extract.ts).
 *
 * `operands` are the ALREADY-REWRITTEN operand sub-expressions (so a nested
 * reactive sub-expression — e.g. `(x + y) * z` — has itself been lowered before
 * it becomes an operand here). The result type is sourced from the ORIGINAL
 * operator `expression` and registered so the lift module's `resultSchema` flows
 * exactly as the un-branded lift's would (review E-5).
 *
 * Fail-closed: this is only ever called for an operator already validated against
 * the `SUPPORTED_EXPR_*_OPERATORS` allow-list (the caller's gate); the runtime
 * `ExprOp` allow-list is the authoritative second gate.
 */
export function createExprLiftCall(
  expression: ts.Expression,
  brand: string,
  operandTokenKind: ts.SyntaxKind,
  isUnary: boolean,
  operands: readonly ts.Expression[],
  context: TransformationContext,
): ts.Expression {
  const { factory, cfHelpers } = context;

  // Reserve fresh positional param identifiers that cannot collide with names in
  // the operand expressions. We use double-underscore prefixes (the synthetic
  // convention) and reserve against an empty set — the body references ONLY
  // these params, never the operand source identifiers.
  const usedNames = new Set<string>();
  const paramIdents = operands.map((_, i) =>
    reserveIdentifier(`__cfExpr${i}`, usedNames, factory)
  );

  // The destructuring array binding pattern: `[__cfExpr0, __cfExpr1]`.
  const arrayBinding = factory.createArrayBindingPattern(
    paramIdents.map((id) =>
      factory.createBindingElement(undefined, undefined, id, undefined)
    ),
  );
  const parameter = factory.createParameterDeclaration(
    undefined,
    undefined,
    arrayBinding,
    undefined,
    undefined,
    undefined,
  );

  // The arrow body re-applies the LITERAL operator over the positional params.
  const body: ts.Expression = isUnary
    ? factory.createPrefixUnaryExpression(
      operandTokenKind as ts.PrefixUnaryOperator,
      paramIdents[0]!,
    )
    : factory.createBinaryExpression(
      paramIdents[0]!,
      operandTokenKind as ts.BinaryOperator,
      paramIdents[1]!,
    );

  const arrowFunction = factory.createArrowFunction(
    undefined,
    undefined,
    [parameter],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    body,
  );
  context.markAsSyntheticComputeCallback?.(arrowFunction);

  // Build the result type node from the ORIGINAL operator expression so the
  // emitted lift module carries the correct `resultSchema` (number for
  // arithmetic, boolean for comparison) exactly as the un-branded lift would.
  const resultType = getTypeAtLocationWithFallback(
    expression,
    context.checker,
    context.options.state?.typeRegistry,
  );
  const resultTypeNode = resultType
    ? typeToTypeNodeWithRegistry(
      resultType,
      {
        checker: context.checker,
        factory,
        sourceFile: context.sourceFile,
      },
      context.options.state?.typeRegistry,
    )
    : undefined;

  // Inner call: `__cfHelpers.exprLift("expr:<op>", arrow)`.
  const innerExprLiftCall = cfHelpers.createHelperCall(
    "exprLift",
    expression,
    undefined,
    [factory.createStringLiteral(brand), arrowFunction],
  );

  // Outer applied call: `(...)([a, b])` — the positional operand array.
  const operandArray = factory.createArrayLiteralExpression(
    [...operands],
    false,
  );
  const exprLiftAppliedCall = factory.createCallExpression(
    innerExprLiftCall,
    undefined,
    [operandArray],
  );

  // Register the applied-call's result type for schema generation + downstream
  // type inference (review E-5; mirrors createLiftAppliedCall).
  if (context.options.state?.typeRegistry && context.checker) {
    registerLiftAppliedCallType(
      exprLiftAppliedCall,
      resultTypeNode,
      resultType,
      context.checker,
      context.options.state?.typeRegistry,
    );
  }

  setParentPointers(exprLiftAppliedCall, expression.parent);
  return exprLiftAppliedCall;
}
