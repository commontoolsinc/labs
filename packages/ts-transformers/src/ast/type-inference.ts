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
 * Infer the type of a function parameter, with optional fallback
 * Returns undefined if the type cannot be inferred
 */
export function inferParameterType(
  parameter: ts.ParameterDeclaration | undefined,
  signature: ts.Signature,
  checker: ts.TypeChecker,
  fallbackType?: ts.Type,
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
  if (parameter.type) {
    const explicitType = checker.getTypeFromTypeNode(parameter.type);
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

  const annotationType = checker.getTypeFromTypeNode(param.type);

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
    // Check if resultTypeNode is already registered
    typeToRegister = typeRegistry.get(resultTypeNode);

    // If not in registry, try getting it from TypeChecker
    if (!typeToRegister) {
      typeToRegister = checker.getTypeFromTypeNode(resultTypeNode);
    }
  }

  if (typeToRegister) {
    typeRegistry.set(deriveCall, typeToRegister);
  }
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
