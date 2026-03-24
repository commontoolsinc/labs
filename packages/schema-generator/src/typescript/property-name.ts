import ts from "typescript";

const KNOWN_COMPUTED_PROPERTY_NAMES = new Map<string, string>([
  ["NAME", "$NAME"],
  ["TYPE", "$TYPE"],
  ["UI", "$UI"],
]);

/**
 * Extract static text for a property name when available.
 * Supports identifier keys plus string/numeric/template literal keys.
 */
export function getPropertyNameText(name: ts.PropertyName): string | undefined {
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
    if (ts.isIdentifier(expr)) {
      return KNOWN_COMPUTED_PROPERTY_NAMES.get(expr.text);
    }
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "__ctHelpers"
    ) {
      return KNOWN_COMPUTED_PROPERTY_NAMES.get(expr.name.text);
    }
  }

  return undefined;
}
