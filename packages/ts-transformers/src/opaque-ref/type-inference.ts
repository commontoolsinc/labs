import ts from "typescript";

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
    return checker.getTypeFromTypeNode(parameter.type);
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
