import ts from "typescript";

/**
 * Checks if a TypeScript type is an OpaqueRef type.
 * Handles intersection types, type references, and type aliases.
 */
export function isOpaqueRefType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  // Debug logging
  const debugType = false; // Set to true to debug type checking
  if (debugType) {
    console.log(
      `[isOpaqueRefType] Checking type: ${checker.typeToString(type)}`,
    );
    console.log(`[isOpaqueRefType] Type flags: ${type.flags}`);
    if (type.aliasSymbol) {
      console.log(
        `[isOpaqueRefType] Alias symbol: ${type.aliasSymbol.getName()}`,
      );
    }
    // Additional debug info
    const symbol = type.getSymbol();
    if (symbol) {
      console.log(`[isOpaqueRefType] Symbol name: ${symbol.getName()}`);
      const declarations = symbol.getDeclarations();
      if (declarations && declarations.length > 0) {
        console.log(
          `[isOpaqueRefType] Symbol declared in: ${
            declarations[0].getSourceFile().fileName
          }`,
        );
      }
    }
  }

  // Handle union types (e.g., OpaqueRef<T> | undefined)
  if (type.flags & ts.TypeFlags.Union) {
    const unionType = type as ts.UnionType;
    // Check if any of the constituent types is OpaqueRef
    return unionType.types.some((t) => isOpaqueRefType(t, checker));
  }

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
      if (
        symbol.name === "OpaqueRef" || symbol.name === "OpaqueRefMethods" ||
        symbol.name === "OpaqueRefBase"
      ) {
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
export function containsOpaqueRef(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const debugContains = false; // Enable debug logging

  const visit = (n: ts.Node): void => {
    if (found) return;

    // For property access expressions, check if the result is an OpaqueRef
    if (ts.isPropertyAccessExpression(n)) {
      const type = checker.getTypeAtLocation(n);
      if (debugContains) {
        console.log(
          `[containsOpaqueRef] Checking PropertyAccess: ${n.getText()}`,
        );
      }
      if (isOpaqueRefType(type, checker)) {
        if (debugContains) {
          console.log(
            `[containsOpaqueRef] Found OpaqueRef in PropertyAccess: ${n.getText()}`,
          );
        }
        found = true;
        return;
      }
    }

    // Skip call expressions with .get() - they return T, not OpaqueRef
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "get" &&
      n.arguments.length === 0
    ) {
      // This is a .get() call, skip checking its children
      return;
    }

    // Check standalone identifiers
    if (ts.isIdentifier(n)) {
      // Skip if this identifier is the name part of a property access
      const parent = n.parent;
      if (
        parent && ts.isPropertyAccessExpression(parent) && parent.name === n
      ) {
        // This is the property name in a property access (e.g., 'count' in 'state.count')
        return;
      }

      const type = checker.getTypeAtLocation(n);
      if (debugContains) {
        console.log(`[containsOpaqueRef] Checking Identifier: ${n.getText()}`);
      }
      if (isOpaqueRefType(type, checker)) {
        if (debugContains) {
          console.log(
            `[containsOpaqueRef] Found OpaqueRef in Identifier: ${n.getText()}`,
          );
        }
        found = true;
        return;
      }
    }

    ts.forEachChild(n, visit);
  };

  if (debugContains) {
    console.log(
      `[containsOpaqueRef] Starting check for node: ${node.getText()}`,
    );
  }
  visit(node);
  if (debugContains) {
    console.log(`[containsOpaqueRef] Result: ${found}`);
  }
  return found;
}

/**
 * Helper function to check if an identifier is a function parameter
 * that we should skip (i.e., callback parameters, not recipe/handler parameters)
 * 
 * First attempts to use TypeScript's symbol API for accurate resolution,
 * falls back to AST traversal if needed.
 */
function isFunctionParameter(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  // Try using TypeScript's symbol API first
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol) {
    const declarations = symbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      // Check if any declaration is a parameter
      const isParam = declarations.some(decl => ts.isParameter(decl));
      if (isParam) {
        // Now check if this is a recipe/handler parameter we should NOT skip
        for (const decl of declarations) {
          if (ts.isParameter(decl)) {
            // Find the containing function
            let parent = decl.parent;
            if (ts.isFunctionExpression(parent) || 
                ts.isArrowFunction(parent) || 
                ts.isFunctionDeclaration(parent) ||
                ts.isMethodDeclaration(parent)) {
              // Check if this function is passed to recipe/handler/lift
              let callExpr: ts.Node = parent;
              while (callExpr.parent && !ts.isCallExpression(callExpr.parent)) {
                callExpr = callExpr.parent;
              }
              if (callExpr.parent && ts.isCallExpression(callExpr.parent)) {
                const funcName = callExpr.parent.expression.getText();
                if (funcName.includes('recipe') || funcName.includes('handler') || funcName.includes('lift')) {
                  return false;
                }
              }
            }
            return true;
          }
        }
      }
    }
  }
  
  // Fallback to AST traversal (original implementation)
  // First check if the identifier itself is in a parameter position
  const parent = node.parent;
  if (ts.isParameter(parent) && parent.name === node) {
    return true;
  }
  
  // For identifiers used in function bodies, we need to check if they
  // reference a parameter of the containing function
  let current: ts.Node = node;
  let containingFunction: ts.FunctionLikeDeclaration | undefined;
  
  // Find the containing function
  while (current.parent) {
    current = current.parent;
    if (ts.isFunctionExpression(current) || 
        ts.isArrowFunction(current) || 
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current)) {
      containingFunction = current as ts.FunctionLikeDeclaration;
      break;
    }
  }
  
  if (containingFunction && containingFunction.parameters) {
    // Check if this identifier matches any parameter name
    for (const param of containingFunction.parameters) {
      if (param.name && ts.isIdentifier(param.name) && param.name.text === node.text) {
        // Special case: Don't skip parameters from recipe/handler functions
        // We DO want to transform state.value, state.items, cell.value, etc.
        // Check if this is a recipe or handler function by looking at the call expression
        let callExpr: ts.Node = containingFunction;
        while (callExpr.parent && !ts.isCallExpression(callExpr.parent)) {
          callExpr = callExpr.parent;
        }
        if (callExpr.parent && ts.isCallExpression(callExpr.parent)) {
          const funcName = callExpr.parent.expression.getText();
          if (funcName.includes('recipe') || funcName.includes('handler') || funcName.includes('lift')) {
            return false;
          }
        }
        
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Collects all OpaqueRef expressions in a node.
 */
export function collectOpaqueRefs(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Expression[] {
  const refs: ts.Expression[] = [];
  const processedNodes = new Set<ts.Node>();

  const visit = (n: ts.Node): void => {
    // Skip if already processed
    if (processedNodes.has(n)) return;
    processedNodes.add(n);

    // For property access expressions, check if the result is an OpaqueRef
    if (ts.isPropertyAccessExpression(n) && ts.isExpression(n)) {
      // Don't collect property access on function parameters as OpaqueRef dependencies
      // Example: state.items.filter(i => i.active)
      // - For i.active: n.expression is 'i' (a callback parameter) → don't collect i.active
      // - For state.items: n.expression is 'state' (a recipe parameter) → do collect state.items
      // This prevents trying to create derive({state_items: state.items, i_active: i.active}, ...)
      // which would fail because 'i' only exists inside the callback, not in outer scope
      if (ts.isIdentifier(n.expression) && isFunctionParameter(n.expression, checker)) {
        return; // Don't add this property access to the OpaqueRef list
      }
      
      // Check if the result of the property access is an OpaqueRef
      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        refs.push(n);
        return; // Don't visit children
      }
    }

    // Check standalone identifiers (not part of property access)
    if (ts.isIdentifier(n) && ts.isExpression(n)) {
      // Skip if this identifier is the name part of a property access
      const parent = n.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === n) {
        // This is the property name in a property access (e.g., 'count' in 'state.count')
        return;
      }

      // Don't collect function parameters as OpaqueRef dependencies
      // Example: state.items.filter(i => i) or array.map((item, index) => index)
      // - 'i' and 'index' are function parameters → don't collect them
      // - 'state' is a recipe parameter → do collect it (if it's an OpaqueRef)
      // This prevents treating callback parameters as reactive dependencies
      if (isFunctionParameter(n, checker)) {
        return;
      }

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
export function isSimpleOpaqueRefAccess(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  // Check if the expression is just a simple identifier or property access
  // that is an OpaqueRef, without any operations on it
  if (
    ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
  ) {
    const type = checker.getTypeAtLocation(expression);
    return isOpaqueRefType(type, checker);
  }
  return false;
}
