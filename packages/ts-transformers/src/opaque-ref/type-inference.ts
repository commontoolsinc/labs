import ts from "typescript";
import { isOpaqueRefType } from "./types.ts";

/**
 * Type inference utilities for function signatures
 * Used primarily by schema-injection to infer types for lift/derive/handler
 */

const TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback;

/**
 * Check if a type is 'any' or 'unknown'
 */
export function isAnyOrUnknownType(type: ts.Type | undefined): boolean {
  if (!type) return false;
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/**
 * Infer the type of a function parameter, with optional fallback
 * Returns undefined if the type cannot be inferred or is 'any'/'unknown'
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
 * Returns undefined if the type cannot be inferred or is 'any'/'unknown'
 */
export function inferReturnType(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  signature: ts.Signature,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const returnType = checker.getReturnTypeOfSignature(signature);

  // Don't use any/unknown types
  if (isAnyOrUnknownType(returnType)) {
    return undefined;
  }

  return returnType;
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
