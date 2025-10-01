import ts from "typescript";

// Constant for identifying CommonTools declarations
const COMMONTOOLS_DECLARATION = "commontools.d.ts";

/**
 * Checks if a declaration comes from the CommonTools library
 */
export function isCommonToolsSymbol(
  symbol: ts.Symbol,
): boolean {
  const declarations = symbol.getDeclarations();
  if (
    declarations && declarations[0]
  ) {
    const source = declarations[0].getSourceFile();
    const fileName = source.fileName.replace(/\\/g, "/");
    return fileName.endsWith(COMMONTOOLS_DECLARATION);
  }
  return false;
}

/**
 * Resolves a symbol to check if it represents a CommonTools export
 */
export function resolvesToCommonToolsSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  targetName: string,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);

  if (symbol.getName() === targetName) {
    if (isCommonToolsSymbol(symbol)) {
      return true;
    }
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (
      aliased &&
      resolvesToCommonToolsSymbol(aliased, checker, targetName, seen)
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
            resolvesToCommonToolsSymbol(
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
 * Checks if a type node represents a CommonTools Default type
 */
function isCommonToolsDefaultTypeNode(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol> = new Set(),
): boolean {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return false;
  if (
    ts.isIdentifier(typeNode.typeName) && typeNode.typeName.text === "Default"
  ) {
    return true;
  }
  const symbol = checker.getSymbolAtLocation(typeNode.typeName);
  if (!symbol || visited.has(symbol)) return false;
  visited.add(symbol);
  if (resolvesToCommonToolsSymbol(symbol, checker, "Default")) {
    return true;
  }
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;
  for (const declaration of declarations) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const aliased = declaration.type;
      if (
        aliased && ts.isTypeReferenceNode(aliased) &&
        isCommonToolsDefaultTypeNode(aliased, checker, visited)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if a symbol declares a CommonTools Default type
 */
export function symbolDeclaresCommonToolsDefault(
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
      isCommonToolsDefaultTypeNode(nodeWithType.type, checker)
    ) {
      return true;
    }
    if (ts.isPropertySignature(declaration) && declaration.type) {
      return isCommonToolsDefaultTypeNode(declaration.type, checker);
    }
    if (ts.isTypeAliasDeclaration(declaration) && declaration.type) {
      return isCommonToolsDefaultTypeNode(declaration.type, checker);
    }
    return false;
  });
}
