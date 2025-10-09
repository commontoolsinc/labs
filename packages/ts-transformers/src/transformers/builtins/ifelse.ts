import ts from "typescript";
import { CTHelpers } from "../../core/mod.ts";

export interface IfElseParams {
  expression: ts.ConditionalExpression;
  factory: ts.NodeFactory;
  ctHelpers: CTHelpers;
  sourceFile: ts.SourceFile;
  overrides?: IfElseOverrides;
}

export interface IfElseOverrides {
  readonly predicate?: ts.Expression;
  readonly whenTrue?: ts.Expression;
  readonly whenFalse?: ts.Expression;
}

export function createIfElseCall(params: IfElseParams): ts.CallExpression {
  const { factory, ctHelpers, overrides, expression } = params;
  const ifElseExpr = ctHelpers.getHelperExpr("ifElse");

  let predicate = overrides?.predicate ?? expression.condition;
  let whenTrue = overrides?.whenTrue ?? expression.whenTrue;
  let whenFalse = overrides?.whenFalse ?? expression.whenFalse;
  while (ts.isParenthesizedExpression(predicate)) {
    predicate = predicate.expression;
  }
  while (ts.isParenthesizedExpression(whenTrue)) whenTrue = whenTrue.expression;
  while (ts.isParenthesizedExpression(whenFalse)) {
    whenFalse = whenFalse.expression;
  }

  return factory.createCallExpression(
    ifElseExpr,
    undefined,
    [predicate, whenTrue, whenFalse],
  );
}
