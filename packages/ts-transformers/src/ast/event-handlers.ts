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

/** Maximum number of parameters for a function to be considered a handler */
const MAX_HANDLER_PARAMS = 2;

/**
 * Check if a return type is consistent with an event handler.
 * Handlers typically return void/undefined, boolean (for "handled" signaling),
 * or Promise versions of these for async handlers.
 */
function isHandlerReturnType(type: ts.Type, checker: ts.TypeChecker): boolean {
  // void or undefined - classic handler return
  if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
    return true;
  }

  // boolean - often used for "handled" or "preventDefault" signaling
  if (type.flags & ts.TypeFlags.BooleanLike) {
    return true;
  }

  // Promise<void|boolean> - async handlers
  const symbol = type.getSymbol();
  if (symbol?.name === "Promise") {
    const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0 && typeArgs[0]) {
      return isHandlerReturnType(typeArgs[0], checker);
    }
  }

  return false;
}

/**
 * Check if a function type represents an event handler signature.
 *
 * Heuristic: A handler is a function with 0-2 parameters that returns
 * void, undefined, boolean, or Promise<void|boolean>.
 *
 * This distinguishes handlers (which notify about events) from data
 * transformers (which return values the component uses, like renderItem,
 * keyExtractor, formatter).
 *
 * Known limitations:
 * - May incorrectly identify predicates like `filter: (item) => boolean`
 *   as handlers (false positive)
 * - May miss handlers with 3+ parameters (false negative, rare in practice)
 */
export function isEventHandlerType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length === 0) {
    return false;
  }

  for (const sig of callSignatures) {
    const params = sig.getParameters();
    const returnType = checker.getReturnTypeOfSignature(sig);

    // Handler heuristic: limited params + handler-compatible return type
    if (
      params.length <= MAX_HANDLER_PARAMS &&
      isHandlerReturnType(returnType, checker)
    ) {
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
