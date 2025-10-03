import ts from "typescript";
import {
  hasCtsEnableDirective,
  TransformationContext,
  Transformer,
} from "../core/mod.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";

export class ClosureTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return hasCtsEnableDirective(context.sourceFile);
  }

  transform(context: TransformationContext): ts.SourceFile {
    const out = transformClosures(context);
    return context.imports.apply(out, context.factory);
  }
}

/**
 * Check if a declaration is at module scope (top-level of source file).
 */
function isModuleScopedDeclaration(decl: ts.Declaration): boolean {
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
 */
function isFunctionDeclaration(decl: ts.Declaration): boolean {
  // Direct function declarations
  if (ts.isFunctionDeclaration(decl)) {
    return true;
  }

  // Arrow functions or function expressions assigned to variables
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (
      ts.isArrowFunction(init) ||
      ts.isFunctionExpression(init) ||
      ts.isCallExpression(init) // Includes handler(), lift(), etc.
    ) {
      return true;
    }
  }

  return false;
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

        // Skip module-scoped declarations
        if (declarations.some((decl) => isModuleScopedDeclaration(decl))) {
          return;
        }

        // Skip function declarations
        if (declarations.some((decl) => isFunctionDeclaration(decl))) {
          return;
        }

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

      // Skip module-scoped declarations (constants/variables at top level)
      const isModuleScoped = declarations.some((decl) =>
        isModuleScopedDeclaration(decl)
      );
      if (isModuleScoped) {
        return;
      }

      // Skip function declarations (can't serialize functions)
      const isFunction = declarations.some((decl) =>
        isFunctionDeclaration(decl)
      );
      if (isFunction) {
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
  if (
    isOpaqueRefType(targetType, checker) &&
    hasArrayTypeArgument(targetType, checker)
  ) {
    return true;
  }

  // Check method chain case: x.filter(...).map(...) where x is OpaqueRef<T[]>
  // Array methods that return arrays and might appear before .map()
  const arrayMethods = [
    "filter",
    "slice",
    "concat",
    "reverse",
    "sort",
    "flat",
    "flatMap",
  ];

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
  return isOpaqueRefType(originType, checker) &&
    hasArrayTypeArgument(originType, checker);
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
  context: TransformationContext,
): ts.CallExpression {
  const { factory, imports } = context;
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

  // IMPORTANT: First, recursively transform any nested map callbacks BEFORE we change
  // parameter names. This ensures nested callbacks can properly detect captures from
  // parent callback scope.
  const { checker } = context;
  let transformedBody = callback.body;

  const nestedVisitor: ts.Visitor = (node) => {
    // Check for nested OpaqueRef<T[]> map calls
    if (ts.isCallExpression(node) && isOpaqueRefArrayMapCall(node, checker)) {
      const nestedCallback = node.arguments[0];
      if (
        nestedCallback &&
        (ts.isArrowFunction(nestedCallback) ||
          ts.isFunctionExpression(nestedCallback))
      ) {
        const nestedCaptures = collectCaptures(nestedCallback, checker);
        if (nestedCaptures.size > 0) {
          const capturesByName = new Map<string, ts.Expression>();
          for (const expr of nestedCaptures) {
            const name = getCaptureName(expr);
            if (name && !capturesByName.has(name)) {
              capturesByName.set(name, expr);
            }
          }
          // Recursively transform the nested callback
          return transformMapCallback(
            node,
            nestedCallback,
            capturesByName,
            context,
          );
        }
      }
    }
    return ts.visitEachChild(node, nestedVisitor, context.transformation);
  };

  transformedBody = ts.visitNode(
    transformedBody,
    nestedVisitor,
  ) as typeof transformedBody;

  // Now transform the callback body to use elem instead of the original param name
  const elemName = elemParam?.name;

  // Collect destructured property names if the param is a destructured binding pattern
  const destructuredProps = new Set<string>();
  if (elemName && ts.isObjectBindingPattern(elemName)) {
    for (const element of elemName.elements) {
      if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
        destructuredProps.add(element.name.text);
      }
    }
  }

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

  // If param was destructured, replace destructured property references with elem.prop
  if (destructuredProps.size > 0) {
    const visitor: ts.Visitor = (node) => {
      if (ts.isIdentifier(node) && destructuredProps.has(node.text)) {
        // Check if this identifier is not part of a property access already
        // (e.g., don't transform the 'x' in 'something.x')
        if (
          !node.parent ||
          !(ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name === node)
        ) {
          return factory.createPropertyAccessExpression(
            factory.createIdentifier("elem"),
            factory.createIdentifier(node.text),
          );
        }
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

function transformClosures(context: TransformationContext): ts.SourceFile {
  const { checker, factory, sourceFile } = context;

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
            context,
          );

          return transformed;
        }
      }
    }

    // Continue visiting children
    return ts.visitEachChild(node, visit, context.transformation);
  }

  return ts.visitNode(sourceFile, visit) as ts.SourceFile;
}
