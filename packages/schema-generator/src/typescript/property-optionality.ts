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

/**
 * Centralized optionality check for properties.
 * Returns true if the property is optional by ANY of these criteria:
 *
 * 1. Symbol has `SymbolFlags.Optional` — this is the primary check.
 *    TypeScript correctly sets/clears this flag for mapped types like
 *    `Required<T>` and `Partial<T>`, even when the original declaration
 *    has a `?` token.
 * 2. Type is a union with `undefined` (e.g., `foo: T | undefined`)
 * 3. Type is `Default<T | undefined, V>` (when typeNode and checker provided)
 *
 * Note: We intentionally do NOT check the declaration's `questionToken` because
 * it reflects the *source* declaration, not the resolved property. For mapped
 * types like `Required<{ a?: string }>`, the declaration still has `?` but
 * `SymbolFlags.Optional` is correctly cleared.
 *
 * @param symbol - The property symbol (may be undefined)
 * @param type - The property type (may be undefined)
 * @param typeNode - Optional type node for Default<> checking
 * @param checker - Optional type checker for Default<> checking
 */
export function isOptionalProperty(
  symbol: ts.Symbol | undefined,
  type: ts.Type | undefined,
  typeNode?: ts.TypeNode,
  checker?: ts.TypeChecker,
): boolean {
  // Primary: check SymbolFlags.Optional
  // This correctly reflects Required<>, Partial<>, and ? modifiers
  if (symbol && isOptionalSymbol(symbol)) {
    return true;
  }

  // Check if type is T | undefined
  if (type && isUnionWithUndefined(type)) {
    return true;
  }

  // Check Default<T | undefined, V>
  if (checker && isDefaultNodeWithUndefined(typeNode, checker)) {
    return true;
  }

  return false;
}

export function isOptionalSymbol(symbol: ts.Symbol): boolean {
  return (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}
