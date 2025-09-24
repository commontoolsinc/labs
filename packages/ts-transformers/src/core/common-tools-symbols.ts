import ts from "typescript";

// Constant for identifying CommonTools declarations
const COMMONTOOLS_DECLARATION = "commontools.d.ts";

/**
 * Checks if a declaration comes from the CommonTools library
 */
export function isCommonToolsDeclaration(
  declaration: ts.Declaration,
): boolean {
  const fileName = declaration.getSourceFile().fileName.replace(/\\/g, "/");
  return fileName.endsWith(COMMONTOOLS_DECLARATION);
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
    const declarations = symbol.getDeclarations();
    if (declarations && declarations.some(isCommonToolsDeclaration)) {
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
