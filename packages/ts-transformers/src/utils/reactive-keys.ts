import ts from "typescript";

import {
  CF_HELPERS_IDENTIFIER,
  resolvesToCommonFabricSymbol,
  type TransformationContext,
} from "../core/mod.ts";

type CommonFabricKeyName = "NAME" | "UI" | "SELF" | "FS";

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

export function isCommonFabricKeyIdentifier(
  expr: ts.Expression,
  context: TransformationContext,
  targetName: CommonFabricKeyName,
): expr is ts.Identifier {
  if (!ts.isIdentifier(expr)) return false;
  const symbol = context.checker.getSymbolAtLocation(expr);
  if (resolvesToCommonFabricSymbol(symbol, context.checker, targetName)) {
    return true;
  }
  // Fall back to name matching for synthetic/transformed contexts where symbol
  // resolution may not find the Common Fabric origin (e.g. virtual test setups).
  return expr.text === targetName;
}

/**
 * Check if an expression is a `__cfHelpers.X` property access for a known key.
 * Prior transformers (e.g. ClosureTransformer) rewrite bare `NAME`/`UI`/`SELF`
 * identifiers into this form.
 */
export function isCtHelpersKeyAccess(
  expr: ts.Expression,
  targetName: CommonFabricKeyName,
): boolean {
  return ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === CF_HELPERS_IDENTIFIER &&
    expr.name.text === targetName;
}

/**
 * Check if an expression refers to a Common Fabric key (NAME/UI/SELF) in either
 * bare identifier or `__cfHelpers.X` property-access form.
 */
export function isCommonFabricKeyExpression(
  expr: ts.Expression,
  context: TransformationContext,
  targetName: CommonFabricKeyName,
): boolean {
  return isCommonFabricKeyIdentifier(expr, context, targetName) ||
    isCtHelpersKeyAccess(expr, targetName);
}

export function getKnownComputedKeyExpression(
  expr: ts.Expression,
  context: TransformationContext,
): ts.Expression | undefined {
  for (const name of ["NAME", "UI", "SELF", "FS"] as const) {
    if (
      isCommonFabricKeyIdentifier(expr, context, name) ||
      isCtHelpersKeyAccess(expr, name)
    ) {
      return context.cfHelpers.getHelperExpr(name);
    }
  }
  return undefined;
}

export function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken;
}
