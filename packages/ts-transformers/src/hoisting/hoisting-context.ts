import ts from "typescript";

/**
 * Types of declarations that can be hoisted to module scope.
 */
export type HoistedDeclarationType = "lift" | "handler" | "derive";

/**
 * Represents a declaration that has been hoisted to module scope.
 */
export interface HoistedDeclaration {
  /**
   * The generated unique name for the hoisted declaration.
   * Examples: __lift_0, __handler_1, __derive_2
   */
  readonly name: string;

  /**
   * The TypeScript variable statement for the hoisted declaration.
   */
  readonly declaration: ts.VariableStatement;

  /**
   * The original position in the source file.
   */
  readonly originalPosition: SourcePosition;

  /**
   * The type of declaration (lift, handler, or derive).
   */
  readonly type: HoistedDeclarationType;

  /**
   * The original node that was hoisted (for debugging and error reporting).
   */
  readonly originalNode: ts.Node;
}

/**
 * Source position information for source map tracking.
 */
export interface SourcePosition {
  /** 1-based line number */
  readonly line: number;
  /** 0-based column number */
  readonly column: number;
  /** 0-based character offset in the file */
  readonly pos: number;
}

/**
 * HoistingContext manages the collection of hoisted declarations
 * during the transformation process.
 *
 * This context is shared across transformer stages to collect
 * declarations that should be moved to module scope for SES
 * compartment safety.
 *
 * @example
 * ```typescript
 * const context = new HoistingContext(sourceFile);
 *
 * // Register a hoisted lift
 * const name = context.registerHoistedDeclaration(
 *   liftVariableStatement,
 *   "lift",
 *   originalNode,
 * );
 *
 * // Later, get all hoisted declarations to prepend to the file
 * const hoisted = context.getHoistedDeclarations();
 * ```
 */
export class HoistingContext {
  private readonly hoistedDeclarations: HoistedDeclaration[] = [];
  private readonly nameCounters: Record<HoistedDeclarationType, number> = {
    lift: 0,
    handler: 0,
    derive: 0,
  };
  private readonly sourceFile: ts.SourceFile;

  constructor(sourceFile: ts.SourceFile) {
    this.sourceFile = sourceFile;
  }

  /**
   * Generate a unique name for a hoisted declaration.
   *
   * @param type - The type of declaration being hoisted
   * @returns A unique identifier like "__lift_0", "__handler_1", etc.
   */
  generateUniqueName(type: HoistedDeclarationType): string {
    const counter = this.nameCounters[type]++;
    return `__${type}_${counter}`;
  }

  /**
   * Register a hoisted declaration.
   *
   * @param declaration - The variable statement to hoist
   * @param type - The type of declaration
   * @param originalNode - The original node being hoisted
   * @returns The generated name for the hoisted declaration
   */
  registerHoistedDeclaration(
    declaration: ts.VariableStatement,
    type: HoistedDeclarationType,
    originalNode: ts.Node,
  ): string {
    const name = this.generateUniqueName(type);
    const originalPosition = this.getSourcePosition(originalNode);

    this.hoistedDeclarations.push({
      name,
      declaration,
      originalPosition,
      type,
      originalNode,
    });

    return name;
  }

  /**
   * Get all hoisted declarations in order.
   *
   * @returns An array of hoisted declarations
   */
  getHoistedDeclarations(): readonly HoistedDeclaration[] {
    return this.hoistedDeclarations;
  }

  /**
   * Check if any declarations have been hoisted.
   *
   * @returns True if there are hoisted declarations
   */
  hasHoistedDeclarations(): boolean {
    return this.hoistedDeclarations.length > 0;
  }

  /**
   * Get the source position for a node.
   *
   * @param node - The node to get position for
   * @returns The source position
   */
  private getSourcePosition(node: ts.Node): SourcePosition {
    const { line, character } = this.sourceFile.getLineAndCharacterOfPosition(
      node.getStart(this.sourceFile),
    );
    return {
      line: line + 1, // Convert to 1-based
      column: character,
      pos: node.getStart(this.sourceFile),
    };
  }

  /**
   * Create the hoisted variable statements to prepend to the file.
   * This generates a single const declaration with all hoisted values.
   *
   * @param factory - The TypeScript node factory
   * @returns Array of variable statements to prepend, or empty if nothing hoisted
   */
  createHoistedStatements(
    _factory: ts.NodeFactory,
  ): ts.VariableStatement[] {
    if (!this.hasHoistedDeclarations()) {
      return [];
    }

    // Return the individual declarations
    return this.hoistedDeclarations.map((h) => h.declaration);
  }
}

/**
 * Checks if a callback function references module-scope symbols
 * (imports, module-scope consts, module-scope functions).
 *
 * Callbacks that reference module-scope symbols must be hoisted to
 * module scope for SES compartment safety, so they become frozen
 * module-level declarations rather than closures over module bindings.
 *
 * @param callback - The callback function to analyze
 * @param checker - TypeScript type checker
 * @returns True if the callback references module-scope symbols and needs hoisting
 */
export function referencesModuleScopeSymbols(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): boolean {
  const paramNames = new Set<string>();
  for (const param of callback.parameters) {
    collectBindingNames(param.name, paramNames);
  }

  const localNames = new Set<string>();
  let hasModuleScopeRef = false;

  const visit = (node: ts.Node): void => {
    if (hasModuleScopeRef) return;

    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, localNames);
    }

    if (ts.isIdentifier(node)) {
      if (isPropertyName(node)) return;

      const name = node.text;
      if (paramNames.has(name) || localNames.has(name)) return;

      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const declarations = symbol.getDeclarations();
        if (declarations && declarations.length > 0) {
          const decl = declarations[0]!;
          const declPos = decl.getStart();
          const callbackStart = callback.getStart();
          const callbackEnd = callback.getEnd();

          if (declPos < callbackStart || declPos > callbackEnd) {
            if (isModuleScopeDeclaration(decl)) {
              hasModuleScopeRef = true;
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(callback.body);
  return hasModuleScopeRef;
}

/**
 * Module specifiers that are provided as compartment globals and
 * don't need hoisting (they're always available in the sandbox).
 */
const RUNTIME_PROVIDED_MODULES = new Set([
  "commontools",
  "@commontools/common",
  "@commontools/ui",
]);

/**
 * Check if a declaration is at module scope (import, module-scope const/function).
 * Excludes imports from runtime-provided modules (commontools, etc.)
 * since those are available as compartment globals.
 */
function isModuleScopeDeclaration(declaration: ts.Declaration): boolean {
  if (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration)
  ) {
    // Check if this import is from a runtime-provided module
    const importDecl = findImportDeclaration(declaration);
    if (importDecl) {
      const moduleSpecifier = importDecl.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        if (RUNTIME_PROVIDED_MODULES.has(moduleSpecifier.text)) {
          return false; // Runtime-provided, no hoisting needed
        }
      }
    }
    return true;
  }

  if (ts.isVariableDeclaration(declaration)) {
    const varStatement = declaration.parent?.parent;
    if (
      varStatement &&
      ts.isVariableStatement(varStatement) &&
      ts.isSourceFile(varStatement.parent)
    ) {
      return true;
    }
  }

  if (ts.isFunctionDeclaration(declaration)) {
    if (declaration.parent && ts.isSourceFile(declaration.parent)) {
      return true;
    }
  }

  return false;
}

/**
 * Walk up the AST from an import specifier/clause to find the ImportDeclaration.
 */
function findImportDeclaration(
  node: ts.Declaration,
): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isImportDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Checks if a callback function is "self-contained" - meaning it has no
 * references to external variables that would require closure capture.
 *
 * A self-contained callback can be safely hoisted to module scope because
 * it doesn't depend on any runtime state from the enclosing function.
 *
 * @param callback - The callback function to analyze
 * @param checker - TypeScript type checker
 * @returns True if the callback is self-contained and can be hoisted
 */
export function isSelfContainedCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): boolean {
  // Get the parameter names so we don't treat them as external references
  const paramNames = new Set<string>();
  for (const param of callback.parameters) {
    collectBindingNames(param.name, paramNames);
  }

  // Track local variable declarations inside the callback
  const localNames = new Set<string>();

  // Check for external references
  let hasExternalReference = false;

  const visit = (node: ts.Node): void => {
    if (hasExternalReference) return;

    // Track local variable declarations
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, localNames);
    }

    // Check identifier references
    if (ts.isIdentifier(node)) {
      // Skip if it's a property name (not a variable reference)
      if (isPropertyName(node)) {
        return;
      }

      const name = node.text;

      // Skip parameters and locals
      if (paramNames.has(name) || localNames.has(name)) {
        return;
      }

      // Check if this identifier refers to something outside the callback
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const declarations = symbol.getDeclarations();
        if (declarations && declarations.length > 0) {
          const decl = declarations[0]!;

          // Check if the declaration is inside the callback
          const declPos = decl.getStart();
          const callbackStart = callback.getStart();
          const callbackEnd = callback.getEnd();

          if (declPos < callbackStart || declPos > callbackEnd) {
            // Declaration is outside the callback
            // Check if it's a module import, global, or built-in (allowed)
            if (!isAllowedExternalReference(decl, checker)) {
              hasExternalReference = true;
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(callback.body);
  return !hasExternalReference;
}

/**
 * Collect all binding names from a binding name (identifier or destructuring pattern).
 */
function collectBindingNames(
  name: ts.BindingName,
  names: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
  } else if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      collectBindingNames(element.name, names);
    }
  } else if (ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
}

/**
 * Check if an identifier is being used as a property name rather than a variable reference.
 */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // Property access: obj.prop - 'prop' is a property name
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }

  // Property assignment: { prop: value } - 'prop' is a property name
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return true;
  }

  // Shorthand property: { prop } - 'prop' is both a property name and a reference
  // We return false here because we want to check if it references an external variable
  if (ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }

  return false;
}

/**
 * Check if an external reference is allowed (imports, globals, built-ins).
 */
function isAllowedExternalReference(
  declaration: ts.Declaration,
  _checker: ts.TypeChecker,
): boolean {
  // Import declarations are allowed (they're module-level bindings)
  if (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration)
  ) {
    return true;
  }

  // Module-scope const declarations are allowed
  if (ts.isVariableDeclaration(declaration)) {
    const varStatement = declaration.parent?.parent;
    if (
      varStatement &&
      ts.isVariableStatement(varStatement) &&
      ts.isSourceFile(varStatement.parent)
    ) {
      // Check if it's const
      const flags = declaration.parent.flags;
      if (flags & ts.NodeFlags.Const) {
        return true;
      }
    }
  }

  // Function declarations at module scope are allowed
  if (ts.isFunctionDeclaration(declaration)) {
    if (declaration.parent && ts.isSourceFile(declaration.parent)) {
      return true;
    }
  }

  // Type-only declarations are allowed (interfaces, type aliases)
  if (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  ) {
    return true;
  }

  // Parameters of enclosing function would indicate a closure - not allowed
  if (ts.isParameter(declaration)) {
    return false;
  }

  return false;
}
