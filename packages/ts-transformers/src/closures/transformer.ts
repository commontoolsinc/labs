import ts from "typescript";
import { ImportRequirements } from "../core/imports.ts";
import { isOpaqueRefType } from "../opaque-ref/types.ts";

export interface ClosureTransformerOptions {
  // Future: options for controlling what gets transformed
}

/**
 * Detects captured variables in a function using TypeScript's symbol table.
 * Returns all captured expressions (both reactive and non-reactive).
 */
function collectCaptures(
  func: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): Set<ts.Expression> {
  const captures = new Set<ts.Expression>();

  // Helper to check if a declaration is within the callback's scope using node identity
  function isDeclaredWithinCallback(decl: ts.Declaration): boolean {
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

  function visit(node: ts.Node) {
    // Don't visit inside nested functions - their scope is separate
    if (node !== func && ts.isFunctionLike(node)) {
      return;
    }

    // For property access like state.discount, capture the whole expression
    if (ts.isPropertyAccessExpression(node)) {
      // Get the root object (e.g., 'state' in 'state.discount')
      let root = node.expression;
      while (ts.isPropertyAccessExpression(root)) {
        root = root.expression;
      }

      if (ts.isIdentifier(root)) {
        const symbol = checker.getSymbolAtLocation(root);
        if (!symbol) return;

        const declarations = symbol.getDeclarations();
        if (!declarations || declarations.length === 0) return;

        // Check if ANY declaration is outside the callback
        const hasExternalDeclaration = declarations.some((decl) =>
          !isDeclaredWithinCallback(decl)
        );

        if (hasExternalDeclaration) {
          // Capture the whole property access expression
          captures.add(node);
          // Don't visit children of this property access
          return;
        }
      }
    }

    // For plain identifiers
    if (ts.isIdentifier(node)) {
      // Skip if node doesn't have a parent (can happen with synthetic nodes)
      if (!node.parent) {
        return;
      }

      // Skip if this is part of a property access (handled above)
      if (
        ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
      ) {
        return;
      }

      // Skip JSX element tag names (e.g., <li>, <div>)
      if (
        ts.isJsxOpeningElement(node.parent) ||
        ts.isJsxClosingElement(node.parent) ||
        ts.isJsxSelfClosingElement(node.parent)
      ) {
        return;
      }

      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) {
        return;
      }

      const declarations = symbol.getDeclarations();
      if (!declarations || declarations.length === 0) {
        return;
      }

      // Check if ALL declarations are within the callback
      const allDeclaredInside = declarations.every((decl) =>
        isDeclaredWithinCallback(decl)
      );

      if (allDeclaredInside) {
        return;
      }

      // Check if it's a JSX attribute (should not be captured)
      const isJsxAttr = declarations.some((decl) => ts.isJsxAttribute(decl));
      if (isJsxAttr) {
        return;
      }

      // Skip imports - they're module-scoped and don't need to be captured
      const isImport = declarations.some((decl) =>
        ts.isImportSpecifier(decl) ||
        ts.isImportClause(decl) ||
        ts.isNamespaceImport(decl)
      );
      if (isImport) {
        return;
      }

      // If we got here, at least one declaration is outside the callback
      // So it's a captured variable
      captures.add(node);
    }

    ts.forEachChild(node, visit);
  }

  if (func.body) {
    visit(func.body);
  }

  return captures;
}

/**
 * Helper to check if a type's type argument is an array.
 * Handles unions and intersections recursively, similar to isOpaqueRefType.
 */
function hasArrayTypeArgument(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  // Handle unions - check if any member has an array type argument
  if (type.flags & ts.TypeFlags.Union) {
    return (type as ts.UnionType).types.some((t) =>
      hasArrayTypeArgument(t, checker)
    );
  }

  // Handle intersections - check if any member has an array type argument
  if (type.flags & ts.TypeFlags.Intersection) {
    return (type as ts.IntersectionType).types.some((t) =>
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
        return checker.isArrayType(innerType) || checker.isTupleType(innerType);
      }
    }
  }

  return false;
}

/**
 * Checks if this is an OpaqueRef<T[]> or Cell<T[]> map call.
 * Only transforms map calls on reactive arrays (OpaqueRef/Cell), not plain arrays.
 *
 * Also handles method chains like state.items.filter(...).map(...) where:
 * - The filter returns OpaqueRef<T>[] (array of OpaqueRefs)
 * - But the origin is OpaqueRef<T[]> (OpaqueRef of array)
 * - We transform it because JSX transformer will wrap intermediate calls in derive
 */
function isOpaqueRefArrayMapCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  // Check if this is a property access expression with name "map"
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "map") return false;

  // Get the type of the target (what we're calling .map on)
  const targetType = checker.getTypeAtLocation(node.expression.expression);

  // Check direct case: target is OpaqueRef<T[]> or Cell<T[]>
  if (isOpaqueRefType(targetType, checker) && hasArrayTypeArgument(targetType, checker)) {
    return true;
  }

  // Check method chain case: x.filter(...).map(...) where x is OpaqueRef<T[]>
  // Array methods that return arrays and might appear before .map()
  const arrayMethods = ['filter', 'slice', 'concat', 'reverse', 'sort', 'flat', 'flatMap'];

  let current: ts.Expression = node.expression.expression;

  // Walk back through call chain to find the origin
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    arrayMethods.includes(current.expression.name.text)
  ) {
    current = current.expression.expression;
  }

  // Check if origin is OpaqueRef<T[]> or Cell<T[]>
  const originType = checker.getTypeAtLocation(current);
  return isOpaqueRefType(originType, checker) && hasArrayTypeArgument(originType, checker);
}

/**
 * Extract the root identifier name from an expression.
 * For property access like state.discount, returns "discount".
 * For plain identifiers, returns the identifier name.
 */
function getCaptureName(expr: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) {
    // For state.discount, capture as "discount"
    return expr.name.text;
  } else if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  return undefined;
}

/**
 * Transform a map callback that captures variables.
 */
function transformMapCallback(
  mapCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  captures: Map<string, ts.Expression>,
  factory: ts.NodeFactory,
  imports: ImportRequirements,
): ts.CallExpression {
  // Build the params object from captures
  const paramProperties: ts.PropertyAssignment[] = [];
  const capturedVarNames = new Set<string>();

  for (const [varName, expr] of captures) {
    capturedVarNames.add(varName);
    // Use the full expression as the param value
    paramProperties.push(
      factory.createPropertyAssignment(
        factory.createIdentifier(varName),
        expr,
      ),
    );
  }

  // If no captures, return the original call
  if (paramProperties.length === 0) {
    return mapCall;
  }

  // Require recipe import
  imports.require({ module: "commontools", name: "recipe" });

  // Transform the callback parameters
  // Original: (item, index?) => ...
  // New: ({elem, index?, params: {captured1, captured2}}) => ...

  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const indexParam = originalParams[1]; // May be undefined

  // Create the destructured parameter
  const properties: ts.BindingElement[] = [
    factory.createBindingElement(
      undefined,
      undefined,
      factory.createIdentifier("elem"),
      undefined,
    ),
  ];

  if (indexParam) {
    properties.push(
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier("index"),
        undefined,
      ),
    );
  }

  // Add params destructuring
  const paramsPattern = factory.createObjectBindingPattern(
    Array.from(capturedVarNames).map((name) =>
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier(name),
        undefined,
      )
    ),
  );

  properties.push(
    factory.createBindingElement(
      undefined,
      factory.createIdentifier("params"),
      paramsPattern,
      undefined,
    ),
  );

  const destructuredParam = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(properties),
    undefined,
    undefined,
    undefined,
  );

  // Transform the callback body to use elem instead of the original param name
  const elemName = elemParam?.name;
  let transformedBody = callback.body;

  // Replace references to the original param with elem
  if (elemName && ts.isIdentifier(elemName) && elemName.text !== "elem") {
    const visitor: ts.Visitor = (node) => {
      if (ts.isIdentifier(node) && node.text === elemName.text) {
        return factory.createIdentifier("elem");
      }
      return ts.visitEachChild(node, visitor, undefined);
    };
    transformedBody = ts.visitNode(
      transformedBody,
      visitor,
    ) as typeof transformedBody;
  }

  // Helper to recursively compare expressions for structural equality
  function expressionsMatch(a: ts.Expression, b: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(a) && ts.isPropertyAccessExpression(b)) {
      // Property names must match
      if (a.name.text !== b.name.text) return false;
      // Recursively compare the object expressions
      return expressionsMatch(a.expression, b.expression);
    } else if (ts.isIdentifier(a) && ts.isIdentifier(b)) {
      return a.text === b.text;
    }
    return false;
  }

  // Replace captured expressions with their parameter names
  for (const [varName, capturedExpr] of captures) {
    const visitor: ts.Visitor = (node) => {
      // Check if this node matches the captured expression
      if (ts.isExpression(node) && expressionsMatch(node, capturedExpr)) {
        return factory.createIdentifier(varName);
      }
      return ts.visitEachChild(node, visitor, undefined);
    };
    transformedBody = ts.visitNode(
      transformedBody,
      visitor,
    ) as typeof transformedBody;
  }

  // Create the new callback
  const newCallback = factory.createArrowFunction(
    callback.modifiers,
    callback.typeParameters,
    [destructuredParam],
    callback.type,
    ts.isArrowFunction(callback)
      ? callback.equalsGreaterThanToken
      : factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    transformedBody,
  );

  // Wrap in recipe()
  const recipeCall = factory.createCallExpression(
    factory.createIdentifier("recipe"),
    undefined,
    [newCallback],
  );

  // Create the params object
  const paramsObject = factory.createObjectLiteralExpression(paramProperties);

  // Return the transformed map call with recipe as first arg, params as second arg
  return factory.createCallExpression(
    mapCall.expression,
    mapCall.typeArguments,
    [recipeCall, paramsObject],
  );
}

export function createClosureTransformer(
  program: ts.Program,
  _options: ClosureTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();

  return (transformation) => (sourceFile) => {
    const factory = transformation.factory;
    const imports = new ImportRequirements();

    function visit(node: ts.Node): ts.Node {
      // Check for OpaqueRef<T[]> or Cell<T[]> map calls with callbacks
      if (ts.isCallExpression(node) && isOpaqueRefArrayMapCall(node, checker)) {
        const callback = node.arguments[0];

        // Check if the callback is an arrow function or function expression
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          // Collect captures
          const captureExpressions = collectCaptures(callback, checker);

          if (captureExpressions.size > 0) {
            // Build map of capture name -> expression
            // For property access like state.discount, we use "discount" as the name
            const capturesByName = new Map<string, ts.Expression>();
            for (const expr of captureExpressions) {
              const name = getCaptureName(expr);
              if (name && !capturesByName.has(name)) {
                capturesByName.set(name, expr);
              }
            }

            // Transform the map call
            const transformed = transformMapCallback(
              node,
              callback,
              capturesByName,
              factory,
              imports,
            );

            return transformed;
          }
        }
      }

      // Continue visiting children
      return ts.visitEachChild(node, visit, transformation);
    }

    const result = ts.visitNode(sourceFile, visit) as ts.SourceFile;

    // Apply import requirements
    return imports.apply(result, factory);
  };
}
