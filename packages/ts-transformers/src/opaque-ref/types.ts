import ts from "typescript";
import {
  getMemberSymbol,
  resolvesToCommonToolsSymbol,
  symbolDeclaresCommonToolsDefault,
} from "../core/common-tools-symbols.ts";

// Re-export commonly used functions
export {
  getMemberSymbol,
  symbolDeclaresCommonToolsDefault,
} from "../core/common-tools-symbols.ts";

export function isOpaqueRefType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if (type.getCallSignatures().length > 0) {
    return false;
  }
  if (type.flags & ts.TypeFlags.Union) {
    return (type as ts.UnionType).types.some((t) =>
      isOpaqueRefType(t, checker)
    );
  }
  if (type.flags & ts.TypeFlags.Intersection) {
    return (type as ts.IntersectionType).types.some((t) =>
      isOpaqueRefType(t, checker)
    );
  }
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      const target = typeRef.target;
      if (target && target.symbol) {
        const symbolName = target.symbol.getName();
        if (symbolName === "OpaqueRef" || symbolName === "Cell") return true;
        if (
          resolvesToCommonToolsSymbol(target.symbol, checker, "Default")
        ) {
          return true;
        }
        const qualified = checker.getFullyQualifiedName(target.symbol);
        if (qualified.includes("OpaqueRef") || qualified.includes("Cell")) {
          return true;
        }
      }
    }
    const symbol = type.getSymbol();
    if (symbol) {
      if (
        symbol.name === "OpaqueRef" ||
        symbol.name === "OpaqueRefMethods" ||
        symbol.name === "OpaqueRefBase" ||
        symbol.name === "Cell"
      ) {
        return true;
      }
      if (resolvesToCommonToolsSymbol(symbol, checker, "Default")) {
        return true;
      }
      const qualified = checker.getFullyQualifiedName(symbol);
      if (qualified.includes("OpaqueRef") || qualified.includes("Cell")) {
        return true;
      }
    }
  }
  if (type.aliasSymbol) {
    const aliasName = type.aliasSymbol.getName();
    if (
      aliasName === "OpaqueRef" ||
      aliasName === "Opaque" ||
      aliasName === "Cell"
    ) {
      return true;
    }
    if (resolvesToCommonToolsSymbol(type.aliasSymbol, checker, "Default")) {
      return true;
    }
    const qualified = checker.getFullyQualifiedName(type.aliasSymbol);
    if (qualified.includes("OpaqueRef") || qualified.includes("Cell")) {
      return true;
    }
  }
  return false;
}

export function containsOpaqueRef(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n)) {
      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        found = true;
        return;
      }
      const propertySymbol = getMemberSymbol(n, checker);
      if (symbolDeclaresCommonToolsDefault(propertySymbol, checker)) {
        found = true;
        return;
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "get" &&
      n.arguments.length === 0
    ) {
      return;
    }
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      if (
        parent && ts.isPropertyAccessExpression(parent) && parent.name === n
      ) {
        return;
      }
      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        found = true;
        return;
      }
      const symbol = checker.getSymbolAtLocation(n);
      if (symbolDeclaresCommonToolsDefault(symbol, checker)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function isSimpleOpaqueRefAccess(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (
    ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
  ) {
    const type = checker.getTypeAtLocation(expression);
    return isOpaqueRefType(type, checker);
  }
  return false;
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

export function isEventHandlerJsxAttribute(node: ts.Node): boolean {
  if (!node || !node.parent) return false;
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) {
    const attrName = parent.name.getText();
    return attrName.startsWith("on");
  }
  return false;
}
