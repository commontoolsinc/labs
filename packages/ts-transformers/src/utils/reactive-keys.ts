import ts from "typescript";

import {
  CF_HELPERS_IDENTIFIER,
  resolvesToCommonFabricSymbol,
  type TransformationContext,
} from "../core/mod.ts";

const COMMON_FABRIC_KEY_NAMES = ["NAME", "UI", "SELF", "FS"] as const;
const COMMON_FABRIC_KEY_NAME_SET = new Set<CommonFabricKeyName>(
  COMMON_FABRIC_KEY_NAMES,
);

export type CommonFabricKeyName = typeof COMMON_FABRIC_KEY_NAMES[number];

function getLiteralComputedKeyValue(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): string | number | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (!checker) {
    return undefined;
  }

  const type = checker.getTypeAtLocation(expr);
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return (type as ts.StringLiteralType).value;
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return (type as ts.NumberLiteralType).value;
  }
  return undefined;
}

export function getCommonFabricKeyName(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): CommonFabricKeyName | undefined {
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === CF_HELPERS_IDENTIFIER &&
    COMMON_FABRIC_KEY_NAME_SET.has(expr.name.text as CommonFabricKeyName)
  ) {
    return expr.name.text as CommonFabricKeyName;
  }

  if (!ts.isIdentifier(expr)) {
    return undefined;
  }

  if (checker) {
    const symbol = checker.getSymbolAtLocation(expr);
    for (const name of COMMON_FABRIC_KEY_NAMES) {
      if (resolvesToCommonFabricSymbol(symbol, checker, name)) {
        return name;
      }
    }
  }

  if (COMMON_FABRIC_KEY_NAME_SET.has(expr.text as CommonFabricKeyName)) {
    return expr.text as CommonFabricKeyName;
  }

  return undefined;
}

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
  return ts.isIdentifier(expr) &&
    getCommonFabricKeyName(expr, context.checker) === targetName;
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
  return getCommonFabricKeyName(expr, context.checker) === targetName;
}

export function getKnownComputedKeyPathSegment(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): string | undefined {
  const literalValue = getLiteralComputedKeyValue(expr, checker);
  if (literalValue !== undefined) {
    return String(literalValue);
  }
  const keyName = getCommonFabricKeyName(expr, checker);
  return keyName ? `$${keyName}` : undefined;
}

export function getKnownComputedKeyExpression(
  expr: ts.Expression,
  context: TransformationContext,
): ts.Expression | undefined {
  const literalValue = getLiteralComputedKeyValue(expr, context.checker);
  if (literalValue !== undefined) {
    return typeof literalValue === "number"
      ? context.factory.createNumericLiteral(literalValue)
      : context.factory.createStringLiteral(literalValue);
  }
  const keyName = getCommonFabricKeyName(expr, context.checker);
  if (keyName) {
    return context.cfHelpers.getHelperExpr(keyName);
  }
  return undefined;
}

export function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken;
}
