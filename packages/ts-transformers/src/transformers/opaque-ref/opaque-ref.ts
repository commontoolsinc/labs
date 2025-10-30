import ts from "typescript";
import {
  resolvesToCommonToolsSymbol,
  symbolDeclaresCommonToolsDefault,
} from "../../core/mod.ts";
import { getMemberSymbol } from "../../ast/mod.ts";

/**
 * Get the CELL_BRAND string value from a type, if it has one.
 * Returns the brand string ("opaque", "cell", "stream", etc.) or undefined.
 */
function getCellBrand(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  // Check for CELL_BRAND property
  const brandSymbol = type.getProperty("CELL_BRAND");
  if (brandSymbol) {
    const brandType = checker.getTypeOfSymbolAtLocation(brandSymbol, brandSymbol.valueDeclaration!);
    // The brand type should be a string literal
    if (brandType.flags & ts.TypeFlags.StringLiteral) {
      return (brandType as ts.StringLiteralType).value;
    }
  }
  return undefined;
}

/**
 * Check if a type is a cell type by looking for the CELL_BRAND property.
 * This includes OpaqueCell, Cell, Stream, and other cell variants.
 */
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

  // Try to get the cell brand first - this is the most reliable method
  const brand = getCellBrand(type, checker);
  if (brand !== undefined) {
    // Valid cell brands: "opaque", "cell", "stream", "comparable", "readonly", "writeonly"
    return ["opaque", "cell", "stream", "comparable", "readonly", "writeonly"].includes(brand);
  }

  // Fallback to legacy detection for backward compatibility
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      const target = typeRef.target;
      if (target && target.symbol) {
        const symbolName = target.symbol.getName();
        // Check for all cell type variants
        if (
          symbolName === "OpaqueRef" ||
          symbolName === "OpaqueCell" ||
          symbolName === "Cell" ||
          symbolName === "Stream" ||
          symbolName === "ComparableCell" ||
          symbolName === "ReadonlyCell" ||
          symbolName === "WriteonlyCell"
        ) {
          return true;
        }
        if (
          resolvesToCommonToolsSymbol(target.symbol, checker, "Default")
        ) {
          return true;
        }
        const qualified = checker.getFullyQualifiedName(target.symbol);
        if (
          qualified.includes("OpaqueRef") ||
          qualified.includes("OpaqueCell") ||
          qualified.includes("Cell") ||
          qualified.includes("Stream")
        ) {
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
        symbol.name === "OpaqueCell" ||
        symbol.name === "Cell" ||
        symbol.name === "Stream" ||
        symbol.name === "ComparableCell" ||
        symbol.name === "ReadonlyCell" ||
        symbol.name === "WriteonlyCell"
      ) {
        return true;
      }
      if (resolvesToCommonToolsSymbol(symbol, checker, "Default")) {
        return true;
      }
      const qualified = checker.getFullyQualifiedName(symbol);
      if (
        qualified.includes("OpaqueRef") ||
        qualified.includes("OpaqueCell") ||
        qualified.includes("Cell") ||
        qualified.includes("Stream")
      ) {
        return true;
      }
    }
  }
  if (type.aliasSymbol) {
    const aliasName = type.aliasSymbol.getName();
    if (
      aliasName === "OpaqueRef" ||
      aliasName === "OpaqueCell" ||
      aliasName === "Opaque" ||
      aliasName === "Cell" ||
      aliasName === "Stream" ||
      aliasName === "ComparableCell" ||
      aliasName === "ReadonlyCell" ||
      aliasName === "WriteonlyCell"
    ) {
      return true;
    }
    if (resolvesToCommonToolsSymbol(type.aliasSymbol, checker, "Default")) {
      return true;
    }
    const qualified = checker.getFullyQualifiedName(type.aliasSymbol);
    if (
      qualified.includes("OpaqueRef") ||
      qualified.includes("OpaqueCell") ||
      qualified.includes("Cell") ||
      qualified.includes("Stream")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Get the cell kind from a type ("opaque", "cell", or "stream").
 * Maps other cell types to their logical category.
 * Returns undefined if not a cell type.
 */
export function getCellKind(type: ts.Type, checker: ts.TypeChecker): "opaque" | "cell" | "stream" | undefined {
  const brand = getCellBrand(type, checker);
  if (brand === undefined) return undefined;

  // Map brands to their logical categories
  switch (brand) {
    case "opaque":
      return "opaque";
    case "cell":
    case "comparable":
    case "readonly":
    case "writeonly":
      // All these are variants of Cell
      return "cell";
    case "stream":
      return "stream";
    default:
      return undefined;
  }
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
