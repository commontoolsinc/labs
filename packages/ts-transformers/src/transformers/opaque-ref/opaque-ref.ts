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

  // Primary method: Check CELL_BRAND property
  const brand = getCellBrand(type, checker);
  if (brand !== undefined) {
    // Valid cell brands: "opaque", "cell", "stream", "comparable", "readonly", "writeonly"
    return ["opaque", "cell", "stream", "comparable", "readonly", "writeonly"].includes(brand);
  }

  // Fallback: Check type reference target symbol name
  // This is needed when CELL_BRAND isn't accessible (e.g., during certain type resolution stages)
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      if (typeRef.target?.symbol) {
        return isCellTypeName(typeRef.target.symbol.getName());
      }
    }
  }

  return false;
}

/**
 * Check if a symbol name matches a known cell type interface name
 */
function isCellTypeName(name: string): boolean {
  return name === "OpaqueRef" ||
    name === "OpaqueRefMethods" ||
    name === "OpaqueRefBase" ||
    name === "OpaqueCell" ||
    name === "IOpaqueCell" ||
    name === "Cell" ||
    name === "ICell" ||
    name === "Stream" ||
    name === "ComparableCell" ||
    name === "ReadonlyCell" ||
    name === "WriteonlyCell" ||
    name === "Opaque";
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
