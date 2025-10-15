import * as ts from "typescript";

/**
 * Safely get text from an expression, handling both regular and synthetic nodes.
 * Synthetic nodes (created by transformers) don't have valid source positions,
 * so we use a printer instead of getText().
 */
export function getExpressionText(expr: ts.Expression): string {
  const sourceFile = expr.getSourceFile();
  if (!sourceFile) {
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

export function isFunctionParameter(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
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
              funcName.includes("recipe") ||
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
  if (ts.isParameter(parent) && parent.name === node) {
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
            funcName.includes("recipe") ||
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
        if (ts.isJsxExpression(child) && child.expression) {
          // Visit the expression inside the JSX expression
          const visitedExpression = ts.visitNode(
            child.expression,
            visitor,
          ) as ts.Expression | undefined;
          return ts.factory.updateJsxExpression(child, visitedExpression);
        }
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
        if (ts.isJsxExpression(child) && child.expression) {
          const visitedExpression = ts.visitNode(
            child.expression,
            visitor,
          ) as ts.Expression | undefined;
          return ts.factory.updateJsxExpression(child, visitedExpression);
        }
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
