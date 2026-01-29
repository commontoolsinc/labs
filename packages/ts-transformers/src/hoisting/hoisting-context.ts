import ts from "typescript";

/**
 * Well-known JS global names used as a fallback when the type checker
 * cannot resolve a symbol (e.g. on synthetic AST nodes created by
 * prior transformers). These should never trigger hoisting.
 *
 * TODO(seefeld): Remove disallowed symbols from this list and instead
 * throw an error when they are referenced. Not all of these globals
 * should be available inside SES compartments.
 */
const WELL_KNOWN_GLOBALS = new Set([
  // ES built-ins
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "Promise",
  "Proxy",
  "Reflect",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "NaN",
  "Infinity",
  "undefined",
  "globalThis",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Intl",
  "Atomics",
  "FinalizationRegistry",
  "Iterator",
  "AsyncIterator",
  "Generator",
  "AsyncGenerator",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
  // Web/runtime globals
  "console",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "fetch",
  "URL",
  "URLSearchParams",
  "Headers",
  "Request",
  "Response",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "crypto",
  "performance",
  "navigator",
  "structuredClone",
  "queueMicrotask",
  "atob",
  "btoa",
]);

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
    // Synthetic nodes (pos === -1) have no real position
    if (node.pos === -1) {
      return { line: 0, column: 0, pos: 0 };
    }
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
 * Checks if a callback references anything outside its own lexical scope
 * (i.e. not its own parameters, local variables, or JS built-in globals).
 *
 * Uses pure name-based tracking rather than positional comparison, which
 * makes it robust against synthetic AST nodes from prior transformers.
 *
 * Any external reference means the callback must be hoisted to module
 * scope for SES compartment safety.
 *
 * @param callback - The callback function to analyze
 * @param checker - TypeScript type checker (used only for built-in detection)
 * @returns True if the callback has external references and needs hoisting
 */
export function referencesExternalSymbols(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): boolean {
  // Collect all names bound inside the callback (params + locals)
  const localNames = new Set<string>();
  for (const param of callback.parameters) {
    collectBindingNames(param.name, localNames);
  }

  let hasExternalRef = false;

  const visit = (node: ts.Node): void => {
    if (hasExternalRef) return;

    // Track local variable declarations as we encounter them
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, localNames);
    }

    // Track function declarations inside the callback
    if (ts.isFunctionDeclaration(node) && node.name) {
      localNames.add(node.name.text);
    }

    if (ts.isIdentifier(node)) {
      if (isPropertyName(node)) return;

      const name = node.text;
      if (localNames.has(name)) return;

      // Check if this is a JS built-in global (Object, Math, Array, etc.)
      // First try the type checker, then fall back to a name-based allowlist
      // (needed when lib file paths don't match the expected pattern or when
      // synthetic nodes prevent symbol resolution).
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && isBuiltinGlobal(symbol)) return;
      // Fallback: only use the name-based allowlist when the checker
      // cannot resolve the symbol (e.g. synthetic nodes from prior
      // transforms). When a symbol IS resolved, trust the checker —
      // a module-scope `const Map = …` should NOT be treated as built-in.
      if (!symbol && WELL_KNOWN_GLOBALS.has(name)) return;

      // Not a local, not a builtin → external reference
      hasExternalRef = true;
    }

    ts.forEachChild(node, visit);
  };

  visit(callback.body);
  return hasExternalRef;
}

/**
 * Check if a symbol is a JavaScript built-in global (Object, Math, Array,
 * console, etc.) by checking if its declaration comes from a TypeScript
 * lib.*.d.ts file.
 */
function isBuiltinGlobal(symbol: ts.Symbol): boolean {
  const declarations = symbol.getDeclarations();
  if (!declarations?.length) {
    // Symbols with no declarations are typically intrinsic types
    // (e.g., undefined, void) — treat as built-in
    return true;
  }

  const sourceFile = declarations[0]!.getSourceFile();
  if (!sourceFile) return false;

  const fileName = sourceFile.fileName.replace(/\\/g, "/");
  return (
    fileName === "lib.d.ts" ||
    fileName.endsWith("/lib.d.ts") ||
    /\/lib\.[\w.]+\.d\.ts$/.test(fileName)
  );
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
