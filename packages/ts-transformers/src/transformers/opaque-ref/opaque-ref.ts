import ts from "typescript";
import { symbolDeclaresCommonToolsDefault } from "../../core/mod.ts";
import { getMemberSymbol } from "../../ast/mod.ts";

/**
 * Get the CELL_BRAND string value from a type, if it has one.
 * Returns the brand string ("opaque", "cell", "stream", etc.) or undefined.
 */
function getCellBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): string | undefined {
  const brandSymbol = findCellBrandSymbol(type, checker, new Set());
  if (!brandSymbol) return undefined;

  const declaration =
    brandSymbol.valueDeclaration ?? brandSymbol.declarations?.[0];
  if (!declaration) return undefined;

  const brandType = checker.getTypeOfSymbolAtLocation(brandSymbol, declaration);
  if (brandType && (brandType.flags & ts.TypeFlags.StringLiteral)) {
    return (brandType as ts.StringLiteralType).value;
  }

  return undefined;
}

function findCellBrandSymbol(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
): ts.Symbol | undefined {
  if (seen.has(type)) return undefined;
  seen.add(type);

  const direct = getBrandSymbolFromType(type, checker);
  if (direct) return direct;

  const apparent = checker.getApparentType(type);
  if (apparent !== type) {
    const fromApparent = findCellBrandSymbol(apparent, checker, seen);
    if (fromApparent) return fromApparent;
  }

  if (type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) {
    const compound = type as ts.UnionOrIntersectionType;
    for (const child of compound.types) {
      const childSymbol = findCellBrandSymbol(child, checker, seen);
      if (childSymbol) return childSymbol;
    }
  }

  if (!(type.flags & ts.TypeFlags.Object)) {
    return undefined;
  }

  const objectType = type as ts.ObjectType;

  if (objectType.objectFlags & ts.ObjectFlags.Reference) {
    const typeRef = objectType as ts.TypeReference;
    if (typeRef.target) {
      const fromTarget = findCellBrandSymbol(typeRef.target, checker, seen);
      if (fromTarget) return fromTarget;
    }
  }

  if (objectType.objectFlags & ts.ObjectFlags.ClassOrInterface) {
    const baseTypes = checker.getBaseTypes(objectType as ts.InterfaceType) ?? [];
    for (const base of baseTypes) {
      const fromBase = findCellBrandSymbol(base, checker, seen);
      if (fromBase) return fromBase;
    }
  }

  return undefined;
}

function getBrandSymbolFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  for (const prop of checker.getPropertiesOfType(type)) {
    if (isCellBrandSymbol(prop)) {
      return prop;
    }
  }
  return undefined;
}

function isCellBrandSymbol(symbol: ts.Symbol): boolean {
  const name = symbol.getName();
  if (name === "CELL_BRAND" || name.startsWith("__@CELL_BRAND")) {
    return true;
  }

  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      ts.isComputedPropertyName(declaration.name)
    ) {
      const expr = declaration.name.expression;
      if (ts.isIdentifier(expr) && expr.text === "CELL_BRAND") {
        return true;
      }
    }
  }

  return false;
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

  // Primary method: look for the CELL_BRAND unique symbol on the type.
  const brand = getCellBrand(type, checker);
  if (brand !== undefined) {
    // Valid cell brands: "opaque", "cell", "stream", "comparable", "readonly", "writeonly"
    return ["opaque", "cell", "stream", "comparable", "readonly", "writeonly"]
      .includes(brand);
  }

  return false;
}

/**
 * Get the cell kind from a type ("opaque", "cell", or "stream").
 * Maps other cell types to their logical category.
 * Returns undefined if not a cell type.
 */
export function getCellKind(
  type: ts.Type,
  checker: ts.TypeChecker,
): "opaque" | "cell" | "stream" | undefined {
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
