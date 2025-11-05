import ts from "typescript";

export type CellBrand =
  | "opaque"
  | "cell"
  | "stream"
  | "comparable"
  | "readonly"
  | "writeonly";

export type CellWrapperKind = "Cell" | "Stream" | "OpaqueRef";

export interface CellWrapperInfo {
  brand: CellBrand;
  kind: CellWrapperKind;
  typeRef: ts.TypeReference;
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
    const baseTypes = checker.getBaseTypes(objectType as ts.InterfaceType) ??
      [];
    for (const base of baseTypes) {
      const fromBase = findCellBrandSymbol(base, checker, seen);
      if (fromBase) return fromBase;
    }
  }

  return undefined;
}

export function getCellBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): CellBrand | undefined {
  const brandSymbol = findCellBrandSymbol(type, checker, new Set());
  if (!brandSymbol) return undefined;

  const declaration = brandSymbol.valueDeclaration ??
    brandSymbol.declarations?.[0];
  if (!declaration) return undefined;

  const brandType = checker.getTypeOfSymbolAtLocation(brandSymbol, declaration);
  if (brandType && (brandType.flags & ts.TypeFlags.StringLiteral)) {
    return (brandType as ts.StringLiteralType).value as CellBrand;
  }

  return undefined;
}

export function isCellType(type: ts.Type, checker: ts.TypeChecker): boolean {
  return getCellBrand(type, checker) !== undefined;
}

export function isCellBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
  brand: CellBrand,
): boolean {
  return getCellBrand(type, checker) === brand;
}

export function getCellKind(
  type: ts.Type,
  checker: ts.TypeChecker,
): "opaque" | "cell" | "stream" | undefined {
  const brand = getCellBrand(type, checker);
  if (brand === undefined) return undefined;

  switch (brand) {
    case "opaque":
      return "opaque";
    case "stream":
      return "stream";
    case "cell":
    case "comparable":
    case "readonly":
    case "writeonly":
      return "cell";
    default:
      return undefined;
  }
}

function brandToWrapperKind(brand: CellBrand): CellWrapperKind | undefined {
  switch (brand) {
    case "opaque":
      return "OpaqueRef";
    case "stream":
      return "Stream";
    case "cell":
    case "comparable":
    case "readonly":
    case "writeonly":
      return "Cell";
    default:
      return undefined;
  }
}

function extractWrapperTypeReference(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
): ts.TypeReference | undefined {
  if (seen.has(type)) return undefined;
  seen.add(type);

  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      const typeArgs = typeRef.typeArguments ??
        checker.getTypeArguments(typeRef);
      if (typeArgs && typeArgs.length > 0) {
        return typeRef;
      }
    }
  }

  if (type.flags & ts.TypeFlags.Intersection) {
    const intersectionType = type as ts.IntersectionType;
    for (const constituent of intersectionType.types) {
      const ref = extractWrapperTypeReference(constituent, checker, seen);
      if (ref) return ref;
    }
  }

  if (type.flags & ts.TypeFlags.Union) {
    const unionType = type as ts.UnionType;
    for (const member of unionType.types) {
      const ref = extractWrapperTypeReference(member, checker, seen);
      if (ref) return ref;
    }
  }

  return undefined;
}

export function getCellWrapperInfo(
  type: ts.Type,
  checker: ts.TypeChecker,
): CellWrapperInfo | undefined {
  const brand = getCellBrand(type, checker);
  if (!brand) return undefined;

  const kind = brandToWrapperKind(brand);
  if (!kind) return undefined;

  const typeRef = extractWrapperTypeReference(type, checker, new Set());
  if (!typeRef) return undefined;

  return { brand, kind, typeRef };
}
