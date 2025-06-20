import ts from "typescript";

/**
 * Checks if a TypeScript type is an OpaqueRef type.
 * Handles intersection types, type references, and type aliases.
 */
export function isOpaqueRefType(type: ts.Type, checker: ts.TypeChecker): boolean {
  // Handle intersection types (OpaqueRef<T> is defined as an intersection)
  if (type.flags & ts.TypeFlags.Intersection) {
    const intersectionType = type as ts.IntersectionType;
    // Check if any of the constituent types is OpaqueRef
    return intersectionType.types.some((t) => isOpaqueRefType(t, checker));
  }

  // Check if it's a type reference
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;

    // Check if it's a reference to a generic type
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      const target = typeRef.target;

      if (target && target.symbol) {
        const symbolName = target.symbol.getName();
        if (symbolName === "OpaqueRef") return true;

        // Also check the fully qualified name
        const fullyQualifiedName = checker.getFullyQualifiedName(target.symbol);
        if (fullyQualifiedName.includes("OpaqueRef")) return true;
      }
    }

    // Also check the type's symbol directly
    const symbol = type.getSymbol();
    if (symbol) {
      if (symbol.name === "OpaqueRef" || symbol.name === "OpaqueRefMethods") {
        return true;
      }

      const fullyQualifiedName = checker.getFullyQualifiedName(symbol);
      if (fullyQualifiedName.includes("OpaqueRef")) return true;
    }
  }

  // Check type alias
  if (type.aliasSymbol) {
    const aliasName = type.aliasSymbol.getName();
    if (aliasName === "OpaqueRef" || aliasName === "Opaque") return true;

    const fullyQualifiedName = checker.getFullyQualifiedName(type.aliasSymbol);
    if (fullyQualifiedName.includes("OpaqueRef")) return true;
  }

  return false;
}

/**
 * Checks if a node contains any OpaqueRef values.
 */
export function containsOpaqueRef(node: ts.Node, checker: ts.TypeChecker): boolean {
  let found = false;
  
  const visit = (n: ts.Node): void => {
    if (found) return;
    
    // Check if this node is an OpaqueRef
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        found = true;
        return;
      }
    }
    
    ts.forEachChild(n, visit);
  };
  
  visit(node);
  return found;
}

/**
 * Collects all OpaqueRef expressions in a node.
 */
export function collectOpaqueRefs(node: ts.Node, checker: ts.TypeChecker): ts.Expression[] {
  const refs: ts.Expression[] = [];
  
  const visit = (n: ts.Node): void => {
    // Check identifiers and property accesses
    if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && ts.isExpression(n)) {
      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        refs.push(n);
      }
    }
    
    ts.forEachChild(n, visit);
  };
  
  visit(node);
  return refs;
}

/**
 * Checks if an expression is a simple OpaqueRef access without any operations.
 */
export function isSimpleOpaqueRefAccess(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  // Check if the expression is just a simple identifier or property access
  // that is an OpaqueRef, without any operations on it
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const type = checker.getTypeAtLocation(expression);
    return isOpaqueRefType(type, checker);
  }
  return false;
}