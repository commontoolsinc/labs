import ts from "typescript";

// Constant for identifying Common Fabric declarations
const COMMONFABRIC_DECLARATION = "commonfabric.d.ts";

/**
 * Checks if a declaration comes from the Common Fabric library
 */
export function isCommonFabricSymbol(
  symbol: ts.Symbol,
): boolean {
  const declarations = symbol.getDeclarations();
  if (
    declarations && declarations[0]
  ) {
    const source = declarations[0].getSourceFile();
    const fileName = source.fileName.replace(/\\/g, "/");
    return fileName.endsWith(COMMONFABRIC_DECLARATION);
  }
  return false;
}

/**
 * Resolves a symbol to check if it represents a Common Fabric export
 */
export function resolvesToCommonFabricSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  targetName: string,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);

  if (symbol.getName() === targetName) {
    if (isCommonFabricSymbol(symbol)) {
      return true;
    }
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (
      aliased &&
      resolvesToCommonFabricSymbol(aliased, checker, targetName, seen)
    ) {
      return true;
    }
  }

  const declarations = symbol.getDeclarations();
  if (declarations) {
    for (const declaration of declarations) {
      if (ts.isTypeAliasDeclaration(declaration)) {
        const aliasType = declaration.type;
        if (aliasType && ts.isTypeReferenceNode(aliasType)) {
          const referenced = checker.getSymbolAtLocation(aliasType.typeName);
          if (
            resolvesToCommonFabricSymbol(
              referenced,
              checker,
              targetName,
              seen,
            )
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Checks if a type node represents a Common Fabric Default type
 */
function isCommonFabricDefaultTypeNode(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol> = new Set(),
): boolean {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return false;
  const symbol = checker.getSymbolAtLocation(typeNode.typeName);
  if (!symbol || visited.has(symbol)) return false;
  visited.add(symbol);
  if (resolvesToCommonFabricSymbol(symbol, checker, "Default")) {
    return true;
  }
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;
  for (const declaration of declarations) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const aliased = declaration.type;
      if (
        aliased && ts.isTypeReferenceNode(aliased) &&
        isCommonFabricDefaultTypeNode(aliased, checker, visited)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if a symbol declares a Common Fabric Default type
 */
export function symbolDeclaresCommonFabricDefault(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!symbol) return false;
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;
  return declarations.some((declaration) => {
    const nodeWithType = declaration as { type?: ts.TypeNode };
    if (
      nodeWithType.type &&
      isCommonFabricDefaultTypeNode(nodeWithType.type, checker)
    ) {
      return true;
    }
    if (ts.isPropertySignature(declaration) && declaration.type) {
      return isCommonFabricDefaultTypeNode(declaration.type, checker);
    }
    if (ts.isTypeAliasDeclaration(declaration) && declaration.type) {
      return isCommonFabricDefaultTypeNode(declaration.type, checker);
    }
    return false;
  });
}
