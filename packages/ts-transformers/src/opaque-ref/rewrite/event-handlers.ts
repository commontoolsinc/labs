import ts from "typescript";

export function isSafeEventHandlerCall(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text.startsWith("on");
  }
  if (ts.isIdentifier(expression)) {
    return expression.text.startsWith("on");
  }
  return false;
}
