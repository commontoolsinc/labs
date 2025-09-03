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
 * TypeScript internal API type extensions for safer casting
 */
export interface TypeWithInternals extends ts.Type {
  aliasSymbol?: ts.Symbol;
  aliasTypeArguments?: readonly ts.Type[];
  resolvedTypeArguments?: readonly ts.Type[];
  intrinsicName?: string;
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
  let name = type.symbol?.name;
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
  // Avoid promoting wrappers/containers into definitions
  if (name === "Array" || name === "ReadonlyArray") return undefined;
  if (name === "Cell" || name === "Stream" || name === "Default") {
    return undefined;
  }
  if (name === "Date") return undefined;
  return name;
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
  const typeFromSymbol = safeGetTypeOfSymbolAtLocation(
    checker,
    prop,
    prop.valueDeclaration!,
    "property symbol location",
  );
  if (typeFromSymbol) return typeFromSymbol;

  // If all else fails, return any
  return checker.getAnyType();
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
 * Extract compile-time default value from a type node
 */
export function extractValueFromTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): any {
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit)) return lit.text;
    if (ts.isNumericLiteral(lit)) return Number(lit.text);
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (lit.kind === ts.SyntaxKind.NullKeyword) return null;
    if (lit.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
    return undefined;
  }

  if (ts.isTypeLiteralNode(node)) {
    const obj: any = {};
    for (const member of node.members) {
      if (
        ts.isPropertySignature(member) && member.name &&
        ts.isIdentifier(member.name)
      ) {
        const propName = member.name.text;
        if (member.type) {
          obj[propName] = extractValueFromTypeNode(member.type, checker);
        }
      }
    }
    return obj;
  }

  if (ts.isTupleTypeNode(node)) {
    return node.elements.map((element: ts.TypeNode) =>
      extractValueFromTypeNode(element, checker)
    );
  }

  // For union defaults like null or undefined (Default<T|null, null>)
  if (ts.isUnionTypeNode(node)) {
    const nullType = node.types.find((t) =>
      t.kind === ts.SyntaxKind.NullKeyword
    );
    const undefType = node.types.find((t) =>
      t.kind === ts.SyntaxKind.UndefinedKeyword
    );
    if (nullType) return null;
    if (undefType) return undefined;
  }

  return undefined;
}
