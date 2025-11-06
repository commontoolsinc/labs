import ts from "typescript";

/**
 * Check if a declaration is at module scope (top-level of source file).
 */
export function isModuleScopedDeclaration(decl: ts.Declaration): boolean {
  // Walk up to find the parent
  let parent = decl.parent;

  // For variable declarations, need to go up through VariableDeclarationList
  if (ts.isVariableDeclaration(decl)) {
    // VariableDeclaration -> VariableDeclarationList -> VariableStatement -> SourceFile
    parent = parent?.parent?.parent;
  }
  // For function declarations, parent is already SourceFile (if module-scoped)
  // No need to reassign

  return parent ? ts.isSourceFile(parent) : false;
}

/**
 * Check if a declaration represents a function (we can't serialize functions).
 * Uses TypeScript's type system to check if the declared value is a function type.
 */
export function isFunctionDeclaration(
  decl: ts.Declaration,
  checker?: ts.TypeChecker,
): boolean {
  // Direct function declarations
  if (ts.isFunctionDeclaration(decl)) {
    return true;
  }

  // Arrow functions or function expressions assigned to variables
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;

    // Direct function syntax
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return true;
    }

    // For call expressions, use type system to determine if result is a function
    if (checker && ts.isCallExpression(init)) {
      const type = checker.getTypeAtLocation(init);
      // Check if the type has call signatures (making it a function type)
      const signatures = type.getCallSignatures();
      if (signatures.length > 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a declaration is within a specific function's scope using node identity.
 * @param decl - The declaration to check
 * @param func - The function to check against
 * @returns true if decl is within func's scope (but stops at nested function boundaries)
 */
export function isDeclaredWithinFunction(
  decl: ts.Declaration,
  func: ts.FunctionLikeDeclaration,
): boolean {
  // Walk up the tree from the declaration
  let current: ts.Node | undefined = decl;
  while (current) {
    // Found our callback function
    if (current === func) {
      return true;
    }

    // Stop at function boundaries (don't cross into nested functions)
    if (current !== decl && ts.isFunctionLike(current)) {
      return false;
    }

    current = current.parent;
  }

  return false;
}

/**
 * Check if a declaration is within any function-like node.
 * Useful for determining if a variable is local vs closure-captured.
 */
export function isDeclaredInFunctionScope(
  decl: ts.Declaration,
): ts.SignatureDeclaration | undefined {
  let current: ts.Node | undefined = decl;
  while (current) {
    if (ts.isFunctionLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}
