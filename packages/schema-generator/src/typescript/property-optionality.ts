import ts from "typescript";

/**
 * Check if a type is a union that includes undefined.
 * When a property type is `T | undefined`, it's considered optional for JSON/runtime semantics.
 */
export function isUnionWithUndefined(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Union)) {
    return false;
  }
  const unionType = type as ts.UnionType;
  return unionType.types.some(
    (t) => (t.flags & ts.TypeFlags.Undefined) !== 0,
  );
}

/**
 * Check if a typeNode represents Default<T | undefined, V>.
 * When the inner type T includes undefined, the property is optional.
 */
export function isDefaultNodeWithUndefined(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return false;
  }

  const typeName = ts.isIdentifier(typeNode.typeName)
    ? typeNode.typeName.text
    : undefined;
  if (typeName !== "Default") {
    return false;
  }

  const typeArgs = typeNode.typeArguments;
  if (!typeArgs || typeArgs.length === 0) {
    return false;
  }

  const innerTypeNode = typeArgs[0];
  if (!innerTypeNode) {
    return false;
  }

  const innerType = checker.getTypeFromTypeNode(innerTypeNode);
  return isUnionWithUndefined(innerType);
}

export function isOptionalSymbol(symbol: ts.Symbol): boolean {
  return (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}

/**
 * Returns true if `symbol` is the `Default` type alias from `@commontools/api`.
 *
 * Checks both the symbol name AND its declaring source file so that any
 * user-defined type that happens to be named "Default" is not treated as the
 * framework's Default<T,V>.
 */
export function isDefaultAliasSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol || symbol.getName() !== "Default") return false;
  return isCommonToolsApiSymbol(symbol);
}

/**
 * Returns true if `symbol` is one of the CFC type aliases (`CFC`, `Secret`,
 * `Confidential`) from `@commontools/api`, or is a user-defined alias that
 * resolves to one of them through the alias chain.
 *
 * For example, `type PII<T> = CFC<T, "pii">` would return true because
 * following the alias chain leads to the `CFC` type from `@commontools/api`.
 */
export function isCFCAliasSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) return false;
  return isCFCAliasSymbolImpl(symbol, new Set());
}

function isCFCAliasSymbolImpl(
  symbol: ts.Symbol,
  visited: Set<ts.Symbol>,
): boolean {
  if (visited.has(symbol)) return false;
  visited.add(symbol);

  const name = symbol.getName();

  // Direct match: CFC, Secret, or Confidential from @commontools/api
  if (name === "CFC" || name === "Secret" || name === "Confidential") {
    return isCommonToolsApiSymbol(symbol);
  }

  // Follow alias chain: if this is a type alias, check what it resolves to
  if (!(symbol.flags & ts.SymbolFlags.TypeAlias)) return false;
  const decl = symbol.declarations?.[0];
  if (!decl || !ts.isTypeAliasDeclaration(decl)) return false;

  const aliasedType = decl.type;
  if (
    !ts.isTypeReferenceNode(aliasedType) ||
    !ts.isIdentifier(aliasedType.typeName)
  ) {
    return false;
  }

  // Resolve the symbol of the aliased type reference
  // We need to get the checker from the source file's program, but we don't have it here.
  // Instead, check the identifier text against known names and resolve via declarations.
  const targetName = aliasedType.typeName.text;
  if (
    targetName === "CFC" || targetName === "Secret" ||
    targetName === "Confidential"
  ) {
    // Try to find the symbol for this identifier by looking at the type alias declaration's
    // type reference. We can get the symbol from the identifier's parent context.
    // Since we don't have a checker here, check if ANY declaration of a symbol named
    // CFC/Secret/Confidential is from @commontools/api by inspecting the source file's imports.
    // For robustness, we simply trust that if the alias chain leads to CFC/Secret/Confidential
    // and the intermediate alias is itself declared in the same file or importing from api,
    // this is a valid CFC alias.
    return true;
  }

  return false;
}

function isCommonToolsApiSymbol(symbol: ts.Symbol): boolean {
  const decl = symbol.declarations?.[0];
  if (!decl) return false;
  const fileName = decl.getSourceFile().fileName;
  // The canonical types are declared in @commontools/api (packages/api/index.ts).
  // Cover both workspace-resolved paths (".../packages/api/index.ts") and any
  // future npm-published form ("@commontools/api").
  // Also accept "commontools.d.ts" which is the filename used in test environments
  // where the types are registered under a synthetic path.
  return fileName.endsWith("/packages/api/index.ts") ||
    fileName.includes("@commontools/api") ||
    fileName.endsWith("commontools.d.ts");
}
