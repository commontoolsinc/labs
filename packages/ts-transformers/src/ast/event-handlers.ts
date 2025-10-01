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

export function isEventHandlerJsxAttribute(node: ts.Node): boolean {
  if (!node || !node.parent) return false;
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) {
    const attrName = parent.name.getText();
    return attrName.startsWith("on");
  }
  return false;
}
