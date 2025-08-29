import ts from "typescript";

/**
 * Get a stable, human-readable type name for definitions
 */
export function getStableTypeName(
  type: ts.Type,
  definitions?: Record<string, any>,
): string {
  const symbolName = type.symbol?.name;
  if (symbolName && symbolName !== "__type") return symbolName;
  if (definitions) {
    return `Type${Object.keys(definitions).length}`;
  }
  return "Type0";
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
export function getArrayElementType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  // Check ObjectFlags.Reference for Array/ReadonlyArray
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;

  if (objectFlags & ts.ObjectFlags.Reference) {
    const typeRef = type as ts.TypeReference;
    const symbol = typeRef.target?.symbol;
    if (
      symbol && (symbol.name === "Array" || symbol.name === "ReadonlyArray")
    ) {
      const elementType = typeRef.typeArguments?.[0];
      return elementType;
    }
  }

  // Check symbol name for Array
  if (type.symbol?.name === "Array") {
    const typeRef = type as ts.TypeReference;
    const elementType = typeRef.typeArguments?.[0];
    return elementType;
  }

  // Use numeric index type as fallback
  try {
    const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (elementType) {
      return elementType;
    }
  } catch (error) {
    // Stack overflow can happen with recursive types
    // Don't log as it could cause another stack overflow
    // Emit a lightweight breadcrumb without touching the error object
    try {
      console.warn(
        "getArrayElementType: checker.getIndexTypeOfType threw; treating as non-array",
      );
    } catch (_e) {
      // Swallow any logging issues to remain safe
    }
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
    try {
      return checker.getTypeFromTypeNode(decl.type);
    } catch (_) {
      // fallthrough
    }
  }
  if (fallbackNode) {
    try {
      return checker.getTypeFromTypeNode(fallbackNode);
    } catch (_) {
      // fallthrough
    }
  }
  // Last resort: use symbol location
  try {
    return checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration!);
  } catch (_) {
    // If all else fails, return any
    return checker.getAnyType();
  }
}

/**
 * Check if a type reference node represents Default<T,V>
 */
export function isDefaultTypeRef(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): boolean {
  if (!node.typeName || !ts.isIdentifier(node.typeName)) return false;

  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (!symbol) return false;

  const symbolName = symbol.getName();
  return symbolName === "Default";
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

  return undefined;
}
