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
 * Check if a type is void-like (void, undefined, or Promise<void>)
 */
function isVoidLike(type: ts.Type, checker: ts.TypeChecker): boolean {
  // Direct void or undefined
  if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
    return true;
  }

  // Promise<void> - check if it's a Promise with void type argument
  const symbol = type.getSymbol();
  if (symbol?.name === "Promise") {
    const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
    if (
      typeArgs.length > 0 && typeArgs[0] && isVoidLike(typeArgs[0], checker)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a function type represents an event handler signature.
 * An event handler is a function that:
 * - Has at least one call signature
 * - Returns void (or void-compatible: undefined, Promise<void>)
 */
export function isEventHandlerType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length === 0) {
    return false;
  }

  // Check if any signature returns void or void-compatible
  for (const sig of callSignatures) {
    const returnType = checker.getReturnTypeOfSignature(sig);
    if (isVoidLike(returnType, checker)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a node is inside a JSX attribute that should be treated as an event handler.
 * Detection uses two strategies:
 * 1. Name-based: attribute name starts with "on" (e.g., onClick, onSubmit)
 * 2. Type-based: the expected type is a function returning void (requires checker)
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
