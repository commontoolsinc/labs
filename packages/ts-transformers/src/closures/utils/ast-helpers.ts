import ts from "typescript";

/**
 * Unwrap an arrow function from parenthesized expressions.
 */
export function unwrapArrowFunction(
  expression: ts.Expression,
): ts.ArrowFunction | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  if (ts.isArrowFunction(current)) {
    return current;
  }
  return undefined;
}

/**
 * Normalize a parameter declaration, optionally replacing its name.
 */
export function normalizeParameter(
  param: ts.ParameterDeclaration,
  newName?: string | ts.BindingName,
): ts.ParameterDeclaration {
  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    newName || param.name,
    undefined,
    undefined,
    undefined,
  );
}
