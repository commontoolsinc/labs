import ts from "typescript";
import { traverseTypeHierarchy } from "./type-traversal.ts";

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
  return traverseTypeHierarchy(type, {
    checker,
    checkType: (t) => getBrandSymbolFromType(t, checker),
    visitApparentType: true,
    visitTypeReferenceTarget: true,
    visitBaseTypes: true,
  }, seen);
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
  return traverseTypeHierarchy(type, {
    checker,
    checkType: (t) => {
      if (t.flags & ts.TypeFlags.Object) {
        const objectType = t as ts.ObjectType;
        if (objectType.objectFlags & ts.ObjectFlags.Reference) {
          const typeRef = objectType as ts.TypeReference;
          const symbol = typeRef.target?.symbol;
          // Only consider wrapper type references that extend BrandedCell
          // This prevents Array<T> from being mistaken for a wrapper in intersections
          // like: T[] & OpaqueCell<T[]> & Array<OpaqueRef<T>>
          // These are the wrapper types defined in @commontools/common-builder that extend BrandedCell:
          // - OpaqueCell<T>: Base opaque wrapper
          // - Cell<T>: Full-featured cell with read/write/stream capabilities
          // - Stream<T>: Stream-only cell (send events only)
          // - ComparableCell<T>: Equality and keying only
          // - ReadonlyCell<T>: Read-only cell variant
          // - WriteonlyCell<T>: Write-only cell variant
          // Note: If new wrapper types extending BrandedCell are added to the API,
          // they should be added to this list.
          if (
            symbol &&
            (symbol.name === "OpaqueCell" || symbol.name === "Cell" ||
              symbol.name === "Stream" || symbol.name === "ComparableCell" ||
              symbol.name === "ReadonlyCell" || symbol.name === "WriteonlyCell")
          ) {
            const typeArgs = typeRef.typeArguments ??
              checker.getTypeArguments(typeRef);
            if (typeArgs && typeArgs.length > 0) {
              return typeRef;
            }
          }
        }
      }
      return undefined;
    },
  }, seen);
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
