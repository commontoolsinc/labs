import ts from "typescript";

import {
  resolvesToCommonToolsSymbol,
  type TransformationContext,
} from "../core/mod.ts";

type CommonToolsKeyName = "NAME" | "UI" | "SELF";

export function cloneKeyExpression(
  expr: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  if (ts.isIdentifier(expr)) {
    return factory.createIdentifier(expr.text);
  }
  if (ts.isStringLiteral(expr)) {
    return factory.createStringLiteral(expr.text);
  }
  if (ts.isNumericLiteral(expr)) {
    return factory.createNumericLiteral(expr.text);
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return factory.createStringLiteral(expr.text);
  }
  return expr;
}

export function isCommonToolsKeyIdentifier(
  expr: ts.Expression,
  context: TransformationContext,
  targetName: CommonToolsKeyName,
): expr is ts.Identifier {
  if (!ts.isIdentifier(expr)) return false;
  const symbol = context.checker.getSymbolAtLocation(expr);
  if (resolvesToCommonToolsSymbol(symbol, context.checker, targetName)) {
    return true;
  }
  // Keep direct-name fallback for transformed helper contexts where symbol
  // resolution can be transient.
  return expr.text === targetName;
}

export function getKnownComputedKeyExpression(
  expr: ts.Expression,
  context: TransformationContext,
): ts.Expression | undefined {
  if (isCommonToolsKeyIdentifier(expr, context, "NAME")) {
    return context.ctHelpers.getHelperExpr("NAME");
  }
  if (isCommonToolsKeyIdentifier(expr, context, "UI")) {
    return context.ctHelpers.getHelperExpr("UI");
  }
  if (isCommonToolsKeyIdentifier(expr, context, "SELF")) {
    return context.ctHelpers.getHelperExpr("SELF");
  }
  return undefined;
}

export function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken;
}
