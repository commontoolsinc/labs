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
  if (symbol) {
    // Symbol resolved — trust the symbol-based check and don't fall through
    // to name matching, which could match user-defined identifiers.
    return resolvesToCommonToolsSymbol(symbol, context.checker, targetName);
  }
  // No symbol found (synthetic/transformed node) — fall back to name matching.
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
