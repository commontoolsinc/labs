import ts from "typescript";
import {
  resolvesToCommonToolsSymbol,
  symbolDeclaresCommonToolsDefault,
} from "../../core/mod.ts";
import { getMemberSymbol } from "../../ast/mod.ts";

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
