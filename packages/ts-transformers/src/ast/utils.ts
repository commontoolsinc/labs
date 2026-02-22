import * as ts from "typescript";

/**
 * Safely get text from an expression, handling both regular and synthetic nodes.
 * Synthetic nodes (created by transformers) don't have valid source positions,
 * so we use a printer instead of getText().
 */
export function getExpressionText(expr: ts.Expression): string {
  const sourceFile = expr.getSourceFile();
  // Check both: no source file OR synthetic node (pos=-1)
  if (!sourceFile || expr.pos === -1) {
    // Synthetic node - use printer
    try {
      const printer = ts.createPrinter();
      return printer.printNode(
        ts.EmitHint.Unspecified,
        expr,
        ts.createSourceFile("", "", ts.ScriptTarget.Latest),
      );
    } catch {
      return `<error printing ${ts.SyntaxKind[expr.kind]}>`;
    }
  }
  return expr.getText(sourceFile);
}

/**
 * Gets the type of a node, checking typeRegistry first (for synthetic nodes),
 * then falling back to the type checker.
 *
 * This is useful when working with nodes that may have been created during
 * transformation (synthetic nodes) which can lose their type information.
 *
 * @param node - The node to get the type for
 * @param checker - The TypeScript type checker
 * @param typeRegistry - Optional registry of types for synthetic nodes
 * @param logger - Optional logger for error messages
 * @returns The type, or undefined if it couldn't be determined
 */
export function getTypeAtLocationWithFallback(
  node: ts.Node,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  logger?: (message: string) => void,
): ts.Type | undefined {
  // Check current node first
  if (typeRegistry?.has(node)) {
    return typeRegistry.get(node)!;
  }

  // Check original node (in case this node was cloned during transformation)
  const original = ts.getOriginalNode(node);
  if (original !== node && typeRegistry?.has(original)) {
    return typeRegistry.get(original)!;
  }

  try {
    return checker.getTypeAtLocation(node);
  } catch (error) {
    if (logger) {
      // Use getExpressionText to safely handle both regular and synthetic nodes
      const nodeText = ts.isExpression(node)
        ? getExpressionText(node)
        : `<${ts.SyntaxKind[node.kind]}>`;
      logger(`Warning: Could not get type for node "${nodeText}": ${error}`);
    }
    return undefined;
  }
}

/**
 * Helper to resolve the base type of an expression
 */
function resolveBaseType(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  let baseType = checker.getTypeAtLocation(expression);
  if (baseType.flags & ts.TypeFlags.Any) {
    const baseSymbol = checker.getSymbolAtLocation(expression);
    if (baseSymbol) {
      const resolved = checker.getTypeOfSymbolAtLocation(
        baseSymbol,
        expression,
      );
      if (resolved) {
        baseType = resolved;
      }
    }
  }
  return baseType;
}

/**
 * Gets the symbol for a property or element access expression
 */
export function getMemberSymbol(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    const direct = checker.getSymbolAtLocation(expression.name);
    if (direct) return direct;
    const baseType = resolveBaseType(expression.expression, checker);
    if (!baseType) return undefined;
    return baseType.getProperty(expression.name.text);
  }

  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    const baseType = resolveBaseType(expression.expression, checker);
    if (!baseType) return undefined;
    return baseType.getProperty(expression.argumentExpression.text);
  }

  return checker.getSymbolAtLocation(expression) ?? undefined;
}

/**
 * Set parent pointers for synthetic nodes created by transformers.
 * Synthetic nodes don't have parent pointers set, which breaks logic
 * that relies on .parent (like method call detection).
 *
 * This is a common utility used when creating synthetic AST nodes that need
 * to participate in parent-based navigation.
 */
export function setParentPointers(node: ts.Node, parent?: ts.Node): void {
  if (parent && !(node as any).parent) {
    (node as any).parent = parent;
  }
  ts.forEachChild(node, (child) => setParentPointers(child, node));
}

// Import and re-export the shared optionality check from schema-generator
import { isOptionalSymbol } from "@commontools/schema-generator/property-optionality";
export { isOptionalSymbol };

/**
 * Check if a property access expression refers to an optional property.
 * Returns true if the property has the `?` optional flag
 *
 * @example
 * ```typescript
 * interface Config {
 *   a?: number;                 // => true (has ? flag)
 *   b: number | undefined;      // => false (union with undefined)
 *   c: number;                  // => false (required)
 *   d?: number | undefined;     // => true (has ? flag)
 * }
 * ```
 */
export function isOptionalMemberSymbol(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): boolean {
  const symbol = getMemberSymbol(expression, checker);
  return symbol !== undefined && isOptionalSymbol(symbol);
}

export function isFunctionParameter(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  // Handle synthetic nodes: if the node doesn't have a source file, we can't traverse parent chain safely
  // Synthetic identifiers from map closure transformation (like `discount`, `element`) are treated as
  // opaque parameters, not regular function parameters
  if (!node.getSourceFile()) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(node);
  if (symbol) {
    const declarations = symbol.getDeclarations();
    if (declarations && declarations.some((decl) => ts.isParameter(decl))) {
      for (const decl of declarations) {
        if (!ts.isParameter(decl)) continue;
        const parent = decl.parent;
        if (
          ts.isFunctionExpression(parent) ||
          ts.isArrowFunction(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isMethodDeclaration(parent)
        ) {
          let callExpr: ts.Node = parent;
          while (callExpr.parent && !ts.isCallExpression(callExpr.parent)) {
            callExpr = callExpr.parent;
          }
          if (callExpr.parent && ts.isCallExpression(callExpr.parent)) {
            const funcName = callExpr.parent.expression.getText();
            if (
              funcName.includes("pattern") ||
              funcName.includes("handler") ||
              funcName.includes("lift")
            ) {
              return false;
            }
          }
        }
        return true;
      }
    }
  }

  const parent = node.parent;
  if (parent && ts.isParameter(parent) && parent.name === node) {
    return true;
  }

  let current: ts.Node = node;
  let containingFunction: ts.FunctionLikeDeclaration | undefined;
  while (current.parent) {
    current = current.parent;
    if (
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    ) {
      containingFunction = current as ts.FunctionLikeDeclaration;
      break;
    }
  }

  if (containingFunction && containingFunction.parameters) {
    for (const param of containingFunction.parameters) {
      if (
        param.name && ts.isIdentifier(param.name) &&
        param.name.text === node.text
      ) {
        let callExpr: ts.Node = containingFunction;
        while (callExpr.parent && !ts.isCallExpression(callExpr.parent)) {
          callExpr = callExpr.parent;
        }
        if (callExpr.parent && ts.isCallExpression(callExpr.parent)) {
          const funcName = callExpr.parent.expression.getText();
          if (
            funcName.includes("pattern") ||
            funcName.includes("handler") ||
            funcName.includes("lift")
          ) {
            return false;
          }
        }
        return true;
      }
    }
  }

  return false;
}

/**
 * Visit a node's children, handling JSX expressions properly.
 * TypeScript's visitEachChild doesn't traverse into JsxExpression.expression,
 * so we need to handle those manually.
 *
 * This is the transformation/visitor version. For read-only analysis,
 * see the special JSX handling in dataflow.ts.
 */
export function visitEachChildWithJsx(
  node: ts.Node,
  visitor: ts.Visitor,
  context: ts.TransformationContext | undefined,
): ts.Node {
  // Handle JSX elements - need to traverse JSX expression children manually
  if (ts.isJsxElement(node)) {
    const openingElement = ts.visitNode(node.openingElement, visitor);
    const children = ts.visitNodes(
      node.children,
      (child) => {
        // Visit the JsxExpression node itself, not just its inner expression
        // This allows transformers to process JsxExpression nodes
        return ts.visitNode(child, visitor);
      },
      ts.isJsxChild,
    );
    const closingElement = ts.visitNode(node.closingElement, visitor);
    return ts.factory.updateJsxElement(
      node,
      openingElement as ts.JsxOpeningElement,
      children,
      closingElement as ts.JsxClosingElement,
    );
  }

  // Handle JSX self-closing elements
  if (ts.isJsxSelfClosingElement(node)) {
    return ts.visitEachChild(node, visitor, context);
  }

  // Handle JSX fragments
  if (ts.isJsxFragment(node)) {
    const openingFragment = ts.visitNode(node.openingFragment, visitor);
    const children = ts.visitNodes(
      node.children,
      (child) => {
        // Visit the child node itself (including JsxExpression nodes)
        return ts.visitNode(child, visitor);
      },
      ts.isJsxChild,
    );
    const closingFragment = ts.visitNode(node.closingFragment, visitor);
    return ts.factory.updateJsxFragment(
      node,
      openingFragment as ts.JsxOpeningFragment,
      children,
      closingFragment as ts.JsxClosingFragment,
    );
  }

  // For all other nodes, use the default behavior
  return ts.visitEachChild(node, visitor, context);
}

/**
 * Check if a property access expression is being invoked as a method call.
 *
 * @example
 * ```typescript
 * // Returns true:
 * obj.method()  // node is obj.method
 *
 * // Returns false:
 * const x = obj.method  // node is obj.method (not being called)
 * ```
 */
export function isMethodCall(node: ts.PropertyAccessExpression): boolean {
  return !!(
    node.parent &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node
  );
}

/**
 * When a property access is a method call, get the object being called on.
 * This is useful for closures that should capture the object, not the method.
 *
 * @example
 * ```typescript
 * state.counter.set()  // Returns PropertyAccessExpression for state.counter
 * obj.method()         // Returns undefined (obj is not a PropertyAccessExpression)
 * obj.prop             // Returns undefined (not a method call)
 * ```
 *
 * @returns The object PropertyAccessExpression if this is a method call on a property chain,
 *          undefined otherwise
 */
export function getMethodCallTarget(
  node: ts.PropertyAccessExpression,
): ts.PropertyAccessExpression | undefined {
  if (!isMethodCall(node)) return undefined;

  const obj = node.expression;
  return ts.isPropertyAccessExpression(obj) ? obj : undefined;
}
