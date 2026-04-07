import ts from "typescript";

const COMMON_FABRIC_KEY_NAMES = new Set(["NAME", "UI", "SELF", "FS"]);

function getCommonFabricComputedKeyName(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): string | undefined {
  if (!ts.isIdentifier(expr)) {
    return undefined;
  }

  if (checker) {
    let symbol = checker.getSymbolAtLocation(expr);
    if (
      symbol &&
      (symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
      checker.getAliasedSymbol
    ) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const resolvedName = symbol?.getName();
    if (resolvedName && COMMON_FABRIC_KEY_NAMES.has(resolvedName)) {
      return `$${resolvedName}`;
    }
  }

  return COMMON_FABRIC_KEY_NAMES.has(expr.text) ? `$${expr.text}` : undefined;
}

/**
 * Extract static text for a property name when available.
 * Supports identifier keys plus string/numeric/template literal keys.
 */
export function getPropertyNameText(
  name: ts.PropertyName,
  checker?: ts.TypeChecker,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  if (ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (
      ts.isStringLiteral(expr) ||
      ts.isNumericLiteral(expr) ||
      ts.isNoSubstitutionTemplateLiteral(expr)
    ) {
      return expr.text;
    }
    return getCommonFabricComputedKeyName(expr, checker);
  }

  return undefined;
}
