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
  // Fall back to alias symbol when present (type aliases)
  if (!name) {
    const aliasName = (type as any).aliasSymbol?.name as string | undefined;
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
      try {
        return {
          elementType: checker.getTypeFromTypeNode(typeNode.elementType),
          elementNode: typeNode.elementType,
        };
      } catch (_) {
        // fall through
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
          try {
            return {
              elementType: checker.getTypeFromTypeNode(argNode),
              elementNode: argNode,
            };
          } catch (_) {
            // fall through
          }
        }
        // Resolve alias: if this is a type alias referring to Array<T> or T[]
        const sym = checker.getSymbolAtLocation(tn);
        const decl = sym?.declarations?.[0];
        if (decl && ts.isTypeAliasDeclaration(decl)) {
          const aliased = decl.type;
          if (ts.isArrayTypeNode(aliased)) {
            try {
              return {
                elementType: checker.getTypeFromTypeNode(aliased.elementType),
                elementNode: aliased.elementType,
              };
            } catch (_) {
              // ignore
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
              try {
                return {
                  elementType: checker.getTypeFromTypeNode(argNode),
                  elementNode: argNode,
                };
              } catch (_) {
                // ignore
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
  try {
    const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (elementType) {
      return { elementType };
    }
  } catch (_error) {
    // Treat as non-array if checker throws during index type resolution
  }

  return undefined;
}

/**
 * Backwards-compatible helper that returns only the element type, built on getArrayElementInfo.
 */
export function getArrayElementType(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
): ts.Type | undefined {
  const info = getArrayElementInfo(type, checker, typeNode);
  return info?.elementType;
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
  // Fast path: identifier text says "Default" even if symbol is missing
  if (node.typeName.text === "Default") return true;

  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (!symbol) return false;

  const symbolName = symbol.getName();
  if (symbolName === "Default") return true;

  // If this is an alias, resolve the alias target to see if it points to Default
  const decl = symbol.declarations?.[0];
  if (decl && ts.isTypeAliasDeclaration(decl)) {
    const aliased = decl.type;
    if (ts.isTypeReferenceNode(aliased) && ts.isIdentifier(aliased.typeName)) {
      return aliased.typeName.text === "Default";
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

/**
 * Synthesize a minimal JSON Schema from a TypeNode without relying on the
 * checker to resolve erased aliases. This is used as a last-resort when
 * Default<T,V> erases to T in the type system and we still want a precise
 * schema for T from syntax alone.
 */
export function synthesizeSchemaFromTypeNode(
  node: ts.TypeNode,
): any /* SchemaDefinition */ {
  // Handle primitive keyword types
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
    case ts.SyntaxKind.NullKeyword:
      return { type: "null" };
    case ts.SyntaxKind.UndefinedKeyword:
      return { type: "string", enum: ["undefined"] };
  }

  // Parenthesized types: unwrap
  if (ts.isParenthesizedTypeNode(node)) {
    return synthesizeSchemaFromTypeNode(node.type);
  }

  // Array types: T[]
  if (ts.isArrayTypeNode(node)) {
    const items = synthesizeSchemaFromTypeNode(node.elementType);
    return { type: "array", items };
  }

  // Tuple types: [A,B,...]
  if (ts.isTupleTypeNode(node)) {
    // For now, expose tuple as array with a union of element shapes
    // (old system typically emitted items for tuples positionally; keeping minimal)
    const items = node.elements.map((e) => synthesizeSchemaFromTypeNode(e));
    // If items are homogenous primitive schemas, collapse to that; otherwise leave first
    // For sustainability, we expose as array of first synthesized item shape
    return { type: "array", items: items[0] ?? { type: "object", additionalProperties: true } };
  }

  // Type literals: { a: T; b?: U }
  if (ts.isTypeLiteralNode(node)) {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const m of node.members) {
      if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)) {
        const name = m.name.text;
        if (!m.questionToken) required.push(name);
        const propSchema = m.type
          ? synthesizeSchemaFromTypeNode(m.type)
          : { type: "object", additionalProperties: true };
        properties[name] = propSchema;
      }
    }
    const out: any = { type: "object", properties };
    if (required.length) out.required = required;
    return out;
  }

  // Union types: special-case null union (T | null)
  if (ts.isUnionTypeNode(node)) {
    const parts = node.types;
    const isNull = (t: ts.TypeNode) => t.kind === ts.SyntaxKind.NullKeyword;
    const hasNull = parts.some(isNull);
    const nonNull = parts.filter((t) => !isNull(t));
    if (hasNull && nonNull.length === 1) {
      const nn = synthesizeSchemaFromTypeNode(nonNull[0]!);
      return { oneOf: [{ type: "null" }, nn] };
    }
  }

  // Reference Array<T> or ReadonlyArray<T>: attempt shallow syntax handling
  if (ts.isTypeReferenceNode(node)) {
    const tn = node.typeName;
    if (
      ts.isIdentifier(tn) &&
      (tn.text === "Array" || tn.text === "ReadonlyArray") &&
      node.typeArguments && node.typeArguments.length > 0
    ) {
      const items = synthesizeSchemaFromTypeNode(node.typeArguments[0]!);
      return { type: "array", items };
    }
  }

  // Fallback generic object
  return { type: "object", additionalProperties: true };
}
