import ts from "typescript";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";
import { getTypeAtLocationWithFallback } from "./utils.ts";

/**
 * Type inference utilities for function signatures
 * Used primarily by schema-injection to infer types for lift/derive/handler
 */

const TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback;

/**
 * Check if a type is 'any', 'unknown', or an uninstantiated type parameter
 * These types cannot be used to generate schemas at compile time
 */
export function isAnyOrUnknownType(type: ts.Type | undefined): boolean {
  if (!type) return false;
  return (type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !==
    0;
}

/**
 * Widen literal types to their base types for more flexible schemas.
 * - NumberLiteral (e.g., 10) → number
 * - StringLiteral (e.g., "hello") → string
 * - BooleanLiteral (e.g., true) → boolean
 * - BigIntLiteral (e.g., 10n) → bigint
 * - Other types are returned unchanged
 */
export function widenLiteralType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type {
  // Handle union types by widening each member and deduplicating
  if (type.isUnion()) {
    // Special case: pure boolean union (true | false) should remain as-is
    // The schema generator has special handling to convert this to {type: "boolean"}
    const isPureBooleanUnion = type.types.length === 2 &&
      type.types.every((m) => (m.flags & ts.TypeFlags.BooleanLiteral) !== 0);
    if (isPureBooleanUnion) {
      return type;
    }

    const widenedMembers = type.types.map((member) =>
      widenLiteralType(member, checker)
    );

    // Deduplicate by comparing type IDs (handles cases like string literals → string)
    const seen = new Set<number>();
    const unique: ts.Type[] = [];
    for (const t of widenedMembers) {
      // Use type identity to deduplicate
      const id = (t as { id?: number }).id ?? -1;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(t);
      }
    }

    // If we reduced to a single type, return it directly
    if (unique.length === 1) {
      return unique[0]!;
    }

    // Otherwise create a new union from unique types
    const getUnionType = (checker as ts.TypeChecker & {
      getUnionType?: (types: readonly ts.Type[]) => ts.Type;
    }).getUnionType;
    if (getUnionType) {
      return getUnionType(unique);
    }
    return type;
  }

  // Number literal → number
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return checker.getNumberType();
  }

  // String literal → string
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return checker.getStringType();
  }

  // Boolean literal (true/false) → boolean
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    // TypeChecker doesn't have getBooleanType(), so we need to create it
    // by getting the union of true | false
    const trueType = checker.getTrueType?.() ?? type;
    const falseType = checker.getFalseType?.() ?? type;
    if (trueType && falseType) {
      return (checker as ts.TypeChecker & {
        getUnionType?: (types: readonly ts.Type[]) => ts.Type;
      }).getUnionType?.([trueType, falseType]) ?? type;
    }
    return type;
  }

  // BigInt literal → bigint
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    return checker.getBigIntType();
  }

  // All other types (including already-widened types) return unchanged
  return type;
}

/**
 * Infer type from an expression with automatic literal widening.
 * Use this for value-based type inference where literal types should
 * be widened to their base types (e.g., `const x = 5` should produce `number`, not `5`).
 *
 * This is the preferred method for inferring types for:
 * - Closure-captured variables
 * - Derive input arguments
 * - Handler/lift captured state
 *
 * @param expr - The expression to infer type from
 * @param checker - TypeChecker instance
 * @returns The widened type (literals expanded to base types)
 */
export function inferWidenedTypeFromExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type {
  const type = checker.getTypeAtLocation(expr);
  return widenLiteralType(type, checker);
}

/**
 * Infer the type of a function parameter, with optional fallback
 * Returns undefined if the type cannot be inferred
 */
export function inferParameterType(
  parameter: ts.ParameterDeclaration | undefined,
  signature: ts.Signature,
  checker: ts.TypeChecker,
  fallbackType?: ts.Type,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  // If no parameter but signature has parameters, try to get from signature
  if (!parameter) {
    if (signature.parameters.length > 0) {
      const paramSymbol = signature.parameters[0];
      if (paramSymbol) {
        const valueDecl = paramSymbol.valueDeclaration;
        const location = valueDecl && ts.isParameter(valueDecl)
          ? valueDecl
          : signature.getDeclaration();
        if (location) {
          return checker.getTypeOfSymbolAtLocation(paramSymbol, location);
        }
      }
    }
    return undefined;
  }

  // If explicit type annotation exists, use it
  // Use fallback to handle synthetic TypeNodes that may be in the registry
  if (parameter.type) {
    const explicitType = getTypeFromTypeNodeWithFallback(
      parameter.type,
      checker,
      typeRegistry,
    );
    return explicitType;
  }

  // Try to infer from parameter location
  let paramType = checker.getTypeAtLocation(parameter);

  // If it's 'any' and we have a fallback, use that
  if (isAnyOrUnknownType(paramType) && fallbackType) {
    paramType = fallbackType;
  }

  return paramType;
}

/**
 * Infer return type from function signature
 * Returns undefined if the type cannot be inferred
 */
export function inferReturnType(
  _fn: ts.ArrowFunction | ts.FunctionExpression,
  signature: ts.Signature,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  return checker.getReturnTypeOfSignature(signature);
}

/**
 * Convert a TypeScript type to a TypeNode for schema generation
 */
export function typeToTypeNode(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
): ts.TypeNode | undefined {
  try {
    const result = checker.typeToTypeNode(type, location, TYPE_NODE_FLAGS);
    return result;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Extract the first type argument from a TypeReference or type alias
 * Used to unwrap generic types like OpaqueRef<T> to get T
 */
export function getTypeReferenceArgument(type: ts.Type): ts.Type | undefined {
  if ("aliasTypeArguments" in type && type.aliasTypeArguments) {
    const [arg] = type.aliasTypeArguments;
    if (arg) return arg;
  }
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const ref = objectType as ts.TypeReference;
      if (ref.typeArguments && ref.typeArguments.length > 0) {
        return ref.typeArguments[0];
      }
    }
  }
  return undefined;
}

/**
 * Unwrap OpaqueRef-like types to get the underlying type
 * Handles unions, intersections, and nested OpaqueRef types
 * @param seen - Set to track visited types and prevent infinite recursion
 */
export function unwrapOpaqueLikeType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): ts.Type | undefined {
  if (!type) return undefined;
  if (seen.has(type)) return type;
  seen.add(type);

  if (type.isUnion()) {
    const unwrapped = type.types.map((candidate) =>
      unwrapOpaqueLikeType(candidate, checker, seen) ?? candidate
    );
    const merged = (checker as ts.TypeChecker & {
      getUnionType?: (types: readonly ts.Type[], node?: ts.Node) => ts.Type;
    }).getUnionType?.(unwrapped) ?? type;
    return merged;
  }

  if (type.isIntersection()) {
    // For OpaqueRef<T> = OpaqueCell<T> & OpaqueRefInner<T>, we want to extract T
    // Look for an OpaqueCell<T> part and extract its type argument
    for (const part of type.types) {
      if (isOpaqueRefType(part, checker)) {
        const inner = getTypeReferenceArgument(part);
        if (inner) {
          // Recursively unwrap in case T itself contains OpaqueRef types
          return unwrapOpaqueLikeType(inner, checker, seen) ?? inner;
        }
      }
    }
    // No OpaqueCell found, try recursively unwrapping each part
    const intersection = (checker as ts.TypeChecker & {
      getIntersectionType?: (types: readonly ts.Type[]) => ts.Type;
    }).getIntersectionType;
    if (intersection) {
      const parts = type.types.map((candidate) =>
        unwrapOpaqueLikeType(candidate, checker, seen) ?? candidate
      );
      return intersection(parts);
    }
    return type;
  }

  if (isOpaqueRefType(type, checker)) {
    const inner = unwrapOpaqueLikeType(
      getTypeReferenceArgument(type),
      checker,
      seen,
    );
    if (inner) return inner;
  }

  return type;
}

/**
 * Convert a TypeScript type to a TypeNode for schema generation
 * Note: Does NOT unwrap Cell/OpaqueRef types - the schema generator handles those
 */
export function typeToSchemaTypeNode(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  location: ts.Node,
): ts.TypeNode | undefined {
  if (!type) {
    return undefined;
  }
  // Don't unwrap Cell/OpaqueRef types - let the schema generator handle them
  const result = typeToTypeNode(type, checker, location);
  return result;
}

/**
 * If a parameter has an explicit type annotation that's not Any,
 * return it and register in TypeRegistry.
 * This is useful for transformers that need to preserve explicit types.
 */
export function tryExplicitParameterType(
  param: ts.ParameterDeclaration | undefined,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): { typeNode: ts.TypeNode; type: ts.Type } | null {
  if (!param?.type) return null;

  // Use fallback to handle synthetic TypeNodes that may be in the registry
  const annotationType = getTypeFromTypeNodeWithFallback(
    param.type,
    checker,
    typeRegistry,
  );

  if (annotationType.flags & ts.TypeFlags.Any) return null;

  if (typeRegistry) {
    typeRegistry.set(param.type, annotationType);
  }

  return { typeNode: param.type, type: annotationType };
}

/**
 * Create a TypeNode and register it with a Type in TypeRegistry.
 * Handles the common pattern of synthetic TypeNode creation.
 * This ensures that later transformer stages can retrieve the Type from synthetic nodes.
 */
export function registerTypeForNode(
  typeNode: ts.TypeNode,
  type: ts.Type,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  if (typeRegistry) {
    typeRegistry.set(typeNode, type);
  }
  return typeNode;
}

/**
 * Get the Type from a TypeNode, checking typeRegistry first.
 *
 * Similar to getTypeAtLocationWithFallback but for TypeNodes specifically.
 * This is useful when working with TypeNodes that may have been created by
 * prior transformers and already have types registered.
 *
 * @param typeNode The TypeNode to get the Type for
 * @param checker TypeChecker instance
 * @param typeRegistry Optional registry of types for synthetic nodes
 * @returns The Type corresponding to the TypeNode
 */
export function getTypeFromTypeNodeWithFallback(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type {
  // Check typeRegistry first (for synthetic TypeNodes)
  if (typeRegistry) {
    const registeredType = typeRegistry.get(typeNode);
    if (registeredType) {
      return registeredType;
    }
  }

  // Fall back to TypeChecker
  return checker.getTypeFromTypeNode(typeNode);
}

/**
 * Register the result type for a synthetic derive CallExpression.
 *
 * This is needed because synthetic nodes created by transformers don't have
 * type information from the TypeChecker. We need to explicitly register the
 * type so that later transformations can infer types correctly.
 *
 * @param deriveCall The synthetic derive CallExpression to register type for
 * @param resultTypeNode The TypeNode representing the derive's result type
 * @param resultType Optional pre-computed Type object for the result
 * @param checker TypeChecker instance
 * @param typeRegistry The type registry to update
 */
export function registerDeriveCallType(
  deriveCall: ts.CallExpression,
  resultTypeNode: ts.TypeNode | undefined,
  resultType: ts.Type | undefined,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type>,
): void {
  // Try to get the type - either from provided resultType or from resultTypeNode
  let typeToRegister = resultType;

  if (!typeToRegister && resultTypeNode) {
    typeToRegister = getTypeFromTypeNodeWithFallback(
      resultTypeNode,
      checker,
      typeRegistry,
    );
  }

  if (typeToRegister) {
    registerSyntheticCallType(deriveCall, typeToRegister, typeRegistry);
  }
}

/**
 * Register the result type for a synthetic call (derive, ifElse, when, unless, etc.) in the TypeRegistry.
 * This enables schema injection to find the correct result type for the call.
 *
 * @param call The synthetic call node
 * @param resultType The result type to register
 * @param typeRegistry The type registry to update
 */
export function registerSyntheticCallType(
  call: ts.CallExpression,
  resultType: ts.Type,
  typeRegistry: WeakMap<ts.Node, ts.Type>,
): void {
  typeRegistry.set(call, resultType);
}

/**
 * Helper to find Reference type within an intersection type
 */
function findReferenceTypeInIntersection(
  intersectionType: ts.IntersectionType,
): ts.Type | undefined {
  for (const type of intersectionType.types) {
    if (type.flags & ts.TypeFlags.Object) {
      const objType = type as ts.ObjectType;
      if (objType.objectFlags & ts.ObjectFlags.Reference) {
        return type;
      }
    }
  }
  return undefined;
}

/**
 * Helper to find OpaqueRef type within a union type
 */
function findOpaqueRefInUnion(
  unionType: ts.UnionType,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  for (const member of unionType.types) {
    if (
      member.flags & ts.TypeFlags.Intersection ||
      isOpaqueRefType(member, checker)
    ) {
      return member;
    }
  }
  return undefined;
}

/**
 * Extract element type from an array type (T[] → T)
 */
function extractElementFromArrayType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (checker.isArrayType(type)) {
    return checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  }
  return undefined;
}

/**
 * Infer the element type from an array-like expression (e.g., OpaqueRef<T[]> or Array<T>).
 * Unwraps one level of array wrapping to get the element type.
 *
 * Handles:
 * - OpaqueRef<T[]> → T[] → T (intersection type case)
 * - Opaque<T[]> → OpaqueRef<T[]> → T[] → T (union type case)
 * - Plain Array<T> → T
 *
 * @param arrayExpr - Expression representing an array or array-like type
 * @param context - Context with checker, factory, and sourceFile
 * @returns Element type and its TypeNode representation, or unknown if inference fails
 */
export function inferArrayElementType(
  arrayExpr: ts.Expression,
  context: {
    checker: ts.TypeChecker;
    factory: ts.NodeFactory;
    sourceFile: ts.SourceFile;
    typeRegistry?: WeakMap<ts.Node, ts.Type>;
  },
): { typeNode: ts.TypeNode; type?: ts.Type } {
  const { checker, factory, typeRegistry } = context;
  // Use getTypeAtLocationWithFallback to check typeRegistry first (for synthetic nodes)
  // getTypeAtLocationWithFallback handles undefined typeRegistry gracefully
  const arrayType =
    getTypeAtLocationWithFallback(arrayExpr, checker, typeRegistry) ??
      checker.getTypeAtLocation(arrayExpr);

  // Try to unwrap OpaqueRef<T[]> → T[] → T
  let actualType = arrayType;

  // Handle intersections (OpaqueRef case)
  if (arrayType.flags & ts.TypeFlags.Intersection) {
    const refType = findReferenceTypeInIntersection(
      arrayType as ts.IntersectionType,
    );
    if (refType) {
      actualType = refType;
    }
  }

  // Handle unions (Opaque<T[]> case)
  if (arrayType.flags & ts.TypeFlags.Union) {
    const opaqueType = findOpaqueRefInUnion(
      arrayType as ts.UnionType,
      checker,
    );
    if (opaqueType) {
      actualType = opaqueType;
    }
  }

  // Extract type arguments from the reference type
  let typeArgs: readonly ts.Type[] | undefined;

  // First check if actualType is an intersection (OpaqueRef case)
  if (actualType.flags & ts.TypeFlags.Intersection) {
    const intersectionType = actualType as ts.IntersectionType;
    // Look for the Reference type member within the intersection
    for (const member of intersectionType.types) {
      if (member.flags & ts.TypeFlags.Object) {
        const objType = member as ts.ObjectType;
        if (objType.objectFlags & ts.ObjectFlags.Reference) {
          typeArgs = checker.getTypeArguments(objType as ts.TypeReference);
          break;
        }
      }
    }
  } else if (actualType.flags & ts.TypeFlags.Object) {
    // Plain object/reference type case
    const objectType = actualType as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      typeArgs = checker.getTypeArguments(objectType as ts.TypeReference);
    }
  }

  if (typeArgs && typeArgs.length > 0) {
    const innerType = typeArgs[0];
    if (innerType) {
      // innerType is either T[] or T depending on the structure
      let elementType: ts.Type;
      if (checker.isArrayType(innerType)) {
        // It's T[], extract T
        const extracted = extractElementFromArrayType(innerType, checker);
        if (extracted) {
          elementType = extracted;
        } else {
          return {
            typeNode: factory.createKeywordTypeNode(
              ts.SyntaxKind.UnknownKeyword,
            ),
          };
        }
      } else {
        // It's already T
        elementType = innerType;
      }

      // Convert Type to TypeNode
      const typeNode =
        typeToTypeNode(elementType, checker, context.sourceFile) ??
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

      return { typeNode, type: elementType };
    }
  }

  // Fallback for plain Array<T>
  const elementType = extractElementFromArrayType(arrayType, checker);
  if (elementType) {
    const typeNode = typeToTypeNode(elementType, checker, context.sourceFile) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

    return { typeNode, type: elementType };
  }

  return {
    typeNode: factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
  };
}
/**
 * Infers the expected type of an expression from its context (e.g., variable assignment).
 */
export function inferContextualType(
  node: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const contextualType = checker.getContextualType(node);
  if (contextualType && !isAnyOrUnknownType(contextualType)) {
    return contextualType;
  }
  return undefined;
}

/**
 * Helper to check if a type's type argument is an array.
 * Handles unions and intersections recursively, similar to isOpaqueRefType.
 */
export function hasArrayTypeArgument(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  // Handle unions - check if any member has an array type argument
  if (type.flags & ts.TypeFlags.Union) {
    return (type as ts.UnionType).types.some((t: ts.Type) =>
      hasArrayTypeArgument(t, checker)
    );
  }

  // Handle intersections - check if any member has an array type argument
  if (type.flags & ts.TypeFlags.Intersection) {
    return (type as ts.IntersectionType).types.some((t: ts.Type) =>
      hasArrayTypeArgument(t, checker)
    );
  }

  // Handle object types with type references (e.g., OpaqueRef<T[]>)
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
        const innerType = typeRef.typeArguments[0];
        if (!innerType) return false;
        // Check if inner type is an array or tuple
        if (checker.isArrayType(innerType) || checker.isTupleType(innerType)) {
          return true;
        }
        // Handle T[] | undefined (from optional WishState properties):
        // strip undefined from the union and check if the remainder is an array
        if (innerType.isUnion()) {
          const nonUndefined = innerType.types.filter(
            (t) => !(t.flags & ts.TypeFlags.Undefined),
          );
          if (
            nonUndefined.length === 1 &&
            (checker.isArrayType(nonUndefined[0]) ||
              checker.isTupleType(nonUndefined[0]))
          ) {
            return true;
          }
        }
        return false;
      }
    }
  }

  return false;
}

/**
 * Check if an expression is a derive call (synthetic or user-written).
 * derive() always returns OpaqueRef<T> at runtime, but we register the
 * unwrapped callback return type in the type registry. This helper lets
 * us detect derive calls syntactically to work around that limitation.
 */
export function isDeriveCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;

  const callee = expr.expression;

  // Check for `derive(...)` direct call
  if (ts.isIdentifier(callee) && callee.text === "derive") {
    return true;
  }

  // Check for `__ctHelpers.derive(...)` qualified call
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "derive"
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if a call expression is a .map() call on a reactive array (OpaqueRef<T[]> or Cell<T[]>).
 * This is used to determine if the map will be transformed to mapWithPattern.
 *
 * Used by both:
 * - ClosureTransformer to decide whether to transform map to mapWithPattern
 * - OpaqueRefJSXTransformer to decide whether to skip derive wrapping (since mapWithPattern is already reactive)
 */
export function isReactiveArrayMapCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  logger?: (message: string) => void,
): boolean {
  // Check if this is a property access expression with name "map"
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "map") return false;

  // Get the type of the target (what we're calling .map on)
  const target = node.expression.expression;

  // Special case: derive() always returns OpaqueRef<T> at runtime.
  // We can't register OpaqueRef<T> in the type registry (only the unwrapped T),
  // so detect derive calls syntactically.
  if (isDeriveCall(target)) {
    return true;
  }

  const targetType = getTypeAtLocationWithFallback(
    target,
    checker,
    typeRegistry,
    logger,
  );
  if (!targetType) {
    return false;
  }

  // Type-based check: target is OpaqueRef<T[]> or Cell<T[]>
  return isOpaqueRefType(targetType, checker) &&
    hasArrayTypeArgument(targetType, checker);
}
