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

/**
 * Check if a type is a function type (has call signatures).
 *
 * In Common Tools JSX, any function passed to an element is treated as an action/handler.
 * We don't need complex heuristics about return types or parameter counts because
 * you can't pass arbitrary data-transformer functions to elements - if you could,
 * they'd be patterns.
 */
export function isEventHandlerType(
  type: ts.Type,
  _checker: ts.TypeChecker,
): boolean {
  return type.getCallSignatures().length > 0;
}

/**
 * Check if a node is inside a JSX attribute that should be treated as an event handler.
 * Detection uses two strategies:
 * 1. Name-based: attribute name starts with "on" (e.g., onClick, onSubmit)
 * 2. Type-based: the expected type is a function (requires checker)
 *
 * @param node - The node to check (typically an identifier or the JsxAttribute itself)
 * @param checker - Optional TypeChecker for type-based detection
 */
export function isEventHandlerJsxAttribute(
  node: ts.Node,
  checker?: ts.TypeChecker,
): boolean {
  if (!node || !node.parent) return false;

  // Find the JsxAttribute - node could be the attribute itself or a child of it
  let jsxAttribute: ts.JsxAttribute | undefined;

  if (ts.isJsxAttribute(node)) {
    jsxAttribute = node;
  } else if (ts.isJsxAttribute(node.parent)) {
    jsxAttribute = node.parent;
  } else {
    return false;
  }

  const attrName = jsxAttribute.name.getText();

  // Fast path: conventional "on*" naming
  if (attrName.startsWith("on")) {
    return true;
  }

  // Type-based detection (requires checker)
  if (
    checker &&
    jsxAttribute.initializer &&
    ts.isJsxExpression(jsxAttribute.initializer)
  ) {
    const expr = jsxAttribute.initializer.expression;
    if (expr) {
      // Get the contextual type (what the component expects for this prop)
      const contextualType = checker.getContextualType(expr);
      if (contextualType && isEventHandlerType(contextualType, checker)) {
        return true;
      }
    }
  }

  return false;
}
