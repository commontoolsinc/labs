import ts from "typescript";

/**
 * Safe wrapper for TypeScript checker APIs that may throw in reduced environments
 */
export function safeGetTypeFromTypeNode(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  context?: string,
): ts.Type | undefined {
  try {
    return checker.getTypeFromTypeNode(node);
  } catch (error) {
    console.warn(
      `Failed to get type from node${context ? ` in ${context}` : ""}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Safe wrapper for getting type of symbol at location
 */
export function safeGetTypeOfSymbolAtLocation(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  location: ts.Node,
  context?: string,
): ts.Type | undefined {
  try {
    return checker.getTypeOfSymbolAtLocation(symbol, location);
  } catch (error) {
    console.warn(
      `Failed to get type of symbol at location${
        context ? ` in ${context}` : ""
      }:`,
      error,
    );
    return undefined;
  }
}

/**
 * Safe wrapper for getting index type
 */
export function safeGetIndexTypeOfType(
  checker: ts.TypeChecker,
  type: ts.Type,
  kind: ts.IndexKind,
  context?: string,
): ts.Type | undefined {
  try {
    return checker.getIndexTypeOfType(type, kind);
  } catch (error) {
    console.warn(
      `Failed to get index type${context ? ` in ${context}` : ""}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Safely resolve a property's type, preferring AST nodes to avoid deep checker recursion
 */
export function safeGetPropertyType(
  prop: ts.Symbol,
  parentType: ts.Type,
  checker: ts.TypeChecker,
  fallbackNode?: ts.TypeNode,
): ts.Type {
  // Prefer declared type node when available
  const decl = prop.valueDeclaration;
  if (decl && ts.isPropertySignature(decl) && decl.type) {
    const typeFromNode = safeGetTypeFromTypeNode(
      checker,
      decl.type,
      "property signature",
    );
    if (typeFromNode) return typeFromNode;
  }

  if (fallbackNode) {
    const typeFromFallback = safeGetTypeFromTypeNode(
      checker,
      fallbackNode,
      "property fallback node",
    );
    if (typeFromFallback) return typeFromFallback;
  }

  // Last resort: use symbol location
  if (decl) {
    const typeFromSymbol = safeGetTypeOfSymbolAtLocation(
      checker,
      prop,
      decl,
      "property symbol location",
    );
    if (typeFromSymbol) return typeFromSymbol;
  }

  // If all else fails, return any
  return checker.getAnyType();
}

/**
 * TypeScript internal API type extensions for safer casting
 */
export interface TypeWithInternals extends ts.Type {
  aliasSymbol?: ts.Symbol;
  aliasTypeArguments?: readonly ts.Type[];
  resolvedTypeArguments?: readonly ts.Type[];
  intrinsicName?: string;
}

/**
 * Resolve the most relevant symbol for a type, accounting for references,
 * aliases, and internal helper accessors exposed on some compiler objects.
 */
export function getPrimarySymbol(type: ts.Type): ts.Symbol | undefined {
  if (type.symbol) return type.symbol;
  const ref = type as ts.TypeReference;
  if (ref.target?.symbol) return ref.target.symbol;
  const alias = (type as TypeWithInternals).aliasSymbol;
  if (alias) return alias;
  return undefined;
}

/**
 * Return a public/stable named key for a type if and only if it has a useful
 * symbol name. Filters out anonymous ("__type") and wrapper/container names
 * that we do not want to promote into top-level definitions.
 */
export function getNamedTypeKey(
  type: ts.Type,
): string | undefined {
  // Prefer direct symbol name; fall back to target symbol for TypeReference
  const symbol = type.symbol;
  let name = symbol?.name;
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
  if (!name && (objectFlags & ts.ObjectFlags.Reference)) {
    const ref = type as unknown as ts.TypeReference;
    name = ref.target?.symbol?.name ?? name;
  }
  // Fall back to alias symbol when present (type aliases)
  if (!name) {
    const aliasName = (type as TypeWithInternals).aliasSymbol?.name;
    if (aliasName) name = aliasName;
  }
  if (!name || name === "__type") return undefined;
  // Exclude property/method-like symbols (member names), which are not real named types
  const symFlags = symbol?.flags ?? 0;
  if (
    (symFlags & ts.SymbolFlags.Property) !== 0 ||
    (symFlags & ts.SymbolFlags.Method) !== 0 ||
    (symFlags & ts.SymbolFlags.Signature) !== 0 ||
    (symFlags & ts.SymbolFlags.Function) !== 0 ||
    (symFlags & ts.SymbolFlags.TypeParameter) !== 0
  ) {
    return undefined;
  }
  const decls = symbol?.declarations ?? [];
  if (
    decls.some((d) =>
      ts.isPropertySignature(d) || ts.isMethodSignature(d) ||
      ts.isPropertyDeclaration(d) || ts.isMethodDeclaration(d)
    )
  ) {
    return undefined;
  }
  // Avoid promoting wrappers/containers into definitions
  if (name === "Array" || name === "ReadonlyArray") return undefined;
  if (name === "Cell" || name === "Stream" || name === "Default") {
    return undefined;
  }
  if (
    name === "Date" || name === "URL" ||
    name === "Uint8Array" || name === "ArrayBuffer"
  ) return undefined;
  return name;
}

/**
 * Determine if a type represents a callable/constructable function value.
 */
export function isFunctionLike(type: ts.Type): boolean {
  if (type.getCallSignatures().length > 0) return true;
  if (type.getConstructSignatures().length > 0) return true;

  const symbol = type.symbol;
  if (!symbol) return false;

  const flags = symbol.flags;
  if (
    (flags & ts.SymbolFlags.Function) !== 0 ||
    (flags & ts.SymbolFlags.Method) !== 0 ||
    (flags & ts.SymbolFlags.Signature) !== 0
  ) {
    return true;
  }

  return false;
}

/**
 * Helper to extract array element type using multiple detection methods
 */
export type ArrayElementInfo = {
  elementType: ts.Type;
  elementNode?: ts.TypeNode;
};

/**
 * Helper to get array element type and, when available, the element node used in the AST.
 * Prefer node-first detection for stability in reduced lib environments and aliases.
 */
export function getArrayElementInfo(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
): ArrayElementInfo | undefined {
  if (typeNode) {
    // Direct syntax T[]
    if (ts.isArrayTypeNode(typeNode)) {
      const elementType = safeGetTypeFromTypeNode(
        checker,
        typeNode.elementType,
        "array element type",
      );
      if (elementType) {
        return {
          elementType,
          elementNode: typeNode.elementType,
        };
      }
    }

    // Reference syntax Array<T> or alias to it
    if (ts.isTypeReferenceNode(typeNode)) {
      const tn = typeNode.typeName;
      if (ts.isIdentifier(tn)) {
        const id = tn.text;
        // If the node itself is Array/ReadonlyArray, use its type argument
        if (
          (id === "Array" || id === "ReadonlyArray") &&
          typeNode.typeArguments && typeNode.typeArguments.length > 0
        ) {
          const argNode = typeNode.typeArguments[0]!;
          const elementType = safeGetTypeFromTypeNode(
            checker,
            argNode,
            "Array<T> type argument",
          );
          if (elementType) {
            return {
              elementType,
              elementNode: argNode,
            };
          }
        }
        // Resolve alias: if this is a type alias referring to Array<T> or T[]
        const sym = checker.getSymbolAtLocation(tn);
        const decl = sym?.declarations?.[0];
        if (decl && ts.isTypeAliasDeclaration(decl)) {
          const aliased = decl.type;
          if (ts.isArrayTypeNode(aliased)) {
            const elementType = safeGetTypeFromTypeNode(
              checker,
              aliased.elementType,
              "aliased array element type",
            );
            if (elementType) {
              return {
                elementType,
                elementNode: aliased.elementType,
              };
            }
          }
          if (ts.isTypeReferenceNode(aliased)) {
            const name = aliased.typeName;
            if (
              ts.isIdentifier(name) &&
              (name.text === "Array" || name.text === "ReadonlyArray") &&
              aliased.typeArguments && aliased.typeArguments.length > 0
            ) {
              const argNode = aliased.typeArguments[0]!;
              const elementType = safeGetTypeFromTypeNode(
                checker,
                argNode,
                "aliased Array<T> type argument",
              );
              if (elementType) {
                return {
                  elementType,
                  elementNode: argNode,
                };
              }
            }
          }
        }
      }
    }
  }

  // Only object-like types can be arrays. Prevent primitives like string
  // from being treated as array-like due to numeric index access.
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }

  const primarySymbol = getPrimarySymbol(type);
  const primaryName = primarySymbol?.name;
  if (primaryName === "Uint8Array" || primaryName === "ArrayBuffer") {
    return undefined;
  }
  // Check ObjectFlags.Reference for Array/ReadonlyArray
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;

  if (objectFlags & ts.ObjectFlags.Reference) {
    const typeRef = type as ts.TypeReference;
    const symbol = typeRef.target?.symbol;
    if (
      symbol && (symbol.name === "Array" || symbol.name === "ReadonlyArray")
    ) {
      const elementType = typeRef.typeArguments?.[0];
      if (elementType) return { elementType };
    }
  }

  // Check symbol name for Array
  if (type.symbol?.name === "Array") {
    const typeRef = type as ts.TypeReference;
    const elementType = typeRef.typeArguments?.[0];
    if (elementType) return { elementType };
  }

  // If the type also has a string index signature, prefer treating it as an
  // object map (not an array). This avoids misclassifying dictionary types
  // like `{ [k: string]: T; [n: number]: T }` as arrays.
  const stringIndex = safeGetIndexTypeOfType(
    checker,
    type,
    ts.IndexKind.String,
    "array/map disambiguation string index",
  );
  const numberIndex = safeGetIndexTypeOfType(
    checker,
    type,
    ts.IndexKind.Number,
    "array/map disambiguation number index",
  );
  if (stringIndex && numberIndex) {
    return undefined;
  }

  // Use numeric index type as fallback (for tuples/array-like objects)
  const elementType = safeGetIndexTypeOfType(
    checker,
    type,
    ts.IndexKind.Number,
    "array numeric index",
  );
  if (elementType) {
    return { elementType };
  }

  return undefined;
}

/**
 * Check if a type reference node represents Default<T,V>
 */
export function isDefaultTypeRef(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol> = new Set(),
): boolean {
  if (!node.typeName || !ts.isIdentifier(node.typeName)) return false;
  // Fast path: identifier text says "Default" even if symbol is missing
  if (node.typeName.text === "Default") return true;

  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (!symbol) return false;

  // Prevent infinite recursion from circular aliases
  if (visited.has(symbol)) return false;
  visited.add(symbol);

  const symbolName = symbol.getName();
  if (symbolName === "Default") return true;

  // If this is an alias, resolve the alias target recursively
  const decl = symbol.declarations?.[0];
  if (decl && ts.isTypeAliasDeclaration(decl)) {
    const aliased = decl.type;
    if (ts.isTypeReferenceNode(aliased)) {
      return isDefaultTypeRef(aliased, checker, visited); // Recursive call with visited set
    }
  }
  return false;
}

/**
 * When a usage is an alias of Cell<T[]> (e.g., type A<T> = Cell<T[]>),
 * return the element type node from the usage site (the T in Cell<T[]>).
 */
export function getAliasElementNodeForCellArray(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (!node || !ts.isTypeReferenceNode(node)) return undefined;
  let current: ts.TypeNode | undefined = node;
  let depth = 0;
  while (current && ts.isTypeReferenceNode(current) && depth < 5) {
    const sym = checker.getSymbolAtLocation(current.typeName);
    const decl = sym?.declarations?.[0];
    if (!decl || !ts.isTypeAliasDeclaration(decl)) break;
    const aliased = decl.type;
    if (ts.isTypeReferenceNode(aliased)) {
      if (
        ts.isIdentifier(aliased.typeName) && aliased.typeName.text === "Cell"
      ) {
        const inner = aliased.typeArguments?.[0];
        if (inner && ts.isArrayTypeNode(inner)) {
          // Found pattern Cell<T[]>; return the actual type argument from usage
          return node.typeArguments?.[0];
        }
        return undefined;
      }
      // Follow the alias reference
      current = aliased;
      depth++;
      continue;
    }
    if (ts.isParenthesizedTypeNode(aliased)) {
      current = aliased.type as ts.TypeNode;
      depth++;
      continue;
    }
    break;
  }
  return undefined;
}

/**
 * Helper for wrapper types (Cell/Stream) to detect if the inner resolves to
 * an array, considering containerArg, inner type, and the syntax node, while
 * optionally skipping when the inner syntactically looks like Default<...>.
 */
export function getContainerArrayElementInfoForWrapper(
  containerArg: ts.Type | undefined,
  innerType: ts.Type,
  innerTypeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  opts: { skipIfInnerLooksLikeDefault?: boolean } = {},
): ArrayElementInfo | undefined {
  const innerLooksLikeDefault = !!(
    innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
    isDefaultTypeRef(innerTypeNode, checker)
  );

  if (opts.skipIfInnerLooksLikeDefault && innerLooksLikeDefault) {
    return undefined;
  }

  if (
    containerArg &&
    !((containerArg.flags & ts.TypeFlags.Object) !== 0 &&
      ((containerArg as ts.TypeReference).target?.symbol?.name === "Default"))
  ) {
    const info = getArrayElementInfo(containerArg, checker, innerTypeNode);
    if (info) return info;
  }

  return getArrayElementInfo(innerType, checker, innerTypeNode);
}
