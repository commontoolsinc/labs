import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  getCellKind,
  isOpaqueRefType,
} from "../transformers/opaque-ref/opaque-ref.ts";
import {
  createDataFlowAnalyzer,
  detectCallKind,
  getMethodCallTarget,
  getTypeAtLocationWithFallback,
  isEventHandlerJsxAttribute,
  isFunctionLikeExpression,
  isMethodCall,
  isOptionalPropertyAccess,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import {
  inferArrayElementType,
  registerTypeForNode,
  tryExplicitParameterType,
} from "../ast/type-inference.ts";
import {
  isDeclaredWithinFunction,
  isFunctionDeclaration,
  isModuleScopedDeclaration,
} from "../ast/scope-analysis.ts";
import {
  buildTypeElementsFromCaptureTree,
  expressionToTypeNode,
} from "../ast/type-building.ts";
import {
  buildHierarchicalParamsValue,
  groupCapturesByRoot,
} from "../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../utils/capture-tree.ts";
import {
  createBindingElementsFromNames,
  createParameterFromBindings,
  createPropertyName,
  getUniqueIdentifier,
  isSafeIdentifierText,
  reserveIdentifier,
} from "../utils/identifiers.ts";
import {
  analyzeElementBinding,
  normalizeBindingName,
  rewriteCallbackBody,
} from "./computed-aliases.ts";
import type { ComputedAliasInfo } from "./computed-aliases.ts";

export class ClosureTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    return transformClosures(context);
  }
}

/**
 * Check if a property access expression should be captured.
 * Returns the expression to capture, or undefined if it shouldn't be captured.
 */
function shouldCapturePropertyAccess(
  node: ts.PropertyAccessExpression,
  func: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): ts.PropertyAccessExpression | undefined {
  // Get the root object (e.g., 'state' in 'state.discount')
  let root = node.expression;
  while (ts.isPropertyAccessExpression(root)) {
    root = root.expression;
  }

  if (!ts.isIdentifier(root)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(root);
  if (!symbol) return undefined;

  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return undefined;

  // Skip module-scoped declarations
  if (declarations.some((decl) => isModuleScopedDeclaration(decl))) {
    return undefined;
  }

  // Skip function declarations
  if (declarations.some((decl) => isFunctionDeclaration(decl, checker))) {
    return undefined;
  }

  // Check if ANY declaration is outside the callback
  const hasExternalDeclaration = declarations.some((decl) =>
    !isDeclaredWithinFunction(decl, func)
  );

  if (hasExternalDeclaration) {
    // Capture the whole property access expression
    return node;
  }

  return undefined;
}

/**
 * Check if an identifier should be captured.
 * Returns the identifier to capture, or undefined if it shouldn't be captured.
 */
function shouldCaptureIdentifier(
  node: ts.Identifier,
  func: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): ts.Identifier | undefined {
  // Skip synthetic nodes (created by transformers, not from source)
  if (!node.getSourceFile()) {
    return undefined;
  }

  // Skip if this is part of a property access (handled separately)
  if (
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
  ) {
    return undefined;
  }

  // For shorthand property assignments (e.g., {id} instead of {id: id}), we need special handling
  // because getSymbolAtLocation returns the property symbol, not the variable being referenced
  if (ts.isShorthandPropertyAssignment(node.parent)) {
    // For shorthand properties, we need to resolve to the actual variable/value being referenced
    // Use the type checker to get the actual symbol of the referenced value
    const propSymbol = checker.getShorthandAssignmentValueSymbol(node.parent);
    if (propSymbol) {
      const propDeclarations = propSymbol.getDeclarations() || [];
      const allDeclaredInside = propDeclarations.every((decl) =>
        isDeclaredWithinFunction(decl, func)
      );
      if (allDeclaredInside) {
        return undefined;
      }
      return node;
    }
    // If we can't resolve the shorthand symbol, fall through to normal handling
  }

  // Skip JSX element tag names (e.g., <li>, <div>)
  if (
    ts.isJsxOpeningElement(node.parent) ||
    ts.isJsxClosingElement(node.parent) ||
    ts.isJsxSelfClosingElement(node.parent)
  ) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) {
    return undefined;
  }

  // Filter out shorthand property assignments - they're not real declarations,
  // they're just syntactic sugar that references the actual declaration elsewhere
  const realDeclarations = declarations.filter((decl) =>
    !ts.isShorthandPropertyAssignment(decl)
  );

  // If all we have are shorthand property assignments, check if this identifier
  // is actually a parameter of the callback itself
  if (realDeclarations.length === 0) {
    // Check if there's a parameter with this name in the callback
    // Use extractBindingNames to handle nested destructuring patterns
    const isCallbackParam = func.parameters.some((param) =>
      extractBindingNames(param.name).includes(node.text)
    );

    if (isCallbackParam) {
      return undefined; // Don't capture - it's just referencing a callback parameter
    }

    // Not a callback parameter, must be from outer scope
    return node;
  }

  // Check if ALL real declarations are within the callback
  const allDeclaredInside = realDeclarations.every((decl) =>
    isDeclaredWithinFunction(decl, func)
  );

  if (allDeclaredInside) {
    return undefined;
  }

  // Check if it's a JSX attribute (should not be captured)
  const isJsxAttr = declarations.some((decl) => ts.isJsxAttribute(decl));
  if (isJsxAttr) {
    return undefined;
  }

  // Skip imports - they're module-scoped and don't need to be captured
  const isImport = declarations.some((decl) =>
    ts.isImportSpecifier(decl) ||
    ts.isImportClause(decl) ||
    ts.isNamespaceImport(decl)
  );
  if (isImport) {
    return undefined;
  }

  // Skip module-scoped declarations (constants/variables at top level)
  const isModuleScoped = declarations.some((decl) =>
    isModuleScopedDeclaration(decl)
  );
  if (isModuleScoped) {
    return undefined;
  }

  // Skip function declarations (can't serialize functions)
  const isFunction = declarations.some((decl) =>
    isFunctionDeclaration(decl, checker)
  );
  if (isFunction) {
    return undefined;
  }

  // If we got here, at least one declaration is outside the callback
  // So it's a captured variable
  return node;
}

/**
 * Type guard for function-like declarations (excludes signature declarations).
 * Used to identify nested functions that can have their own captures.
 * Naming matches pattern: isFunctionLikeExpression (for callbacks), isFunctionLikeDeclaration (for nested functions).
 */
function isFunctionLikeDeclaration(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
}

/**
 * Helper function to check if an identifier is a parameter or local variable of a function.
 * Used by both shouldCaptureIdentifier and shouldAddNestedCapture to determine if an
 * identifier should be filtered out from captures.
 */
/**
 * Recursively extract all binding names from a parameter binding pattern.
 * Handles identifiers, object destructuring, array destructuring, and nested patterns.
 */
function extractBindingNames(binding: ts.BindingName): string[] {
  if (ts.isIdentifier(binding)) {
    return [binding.text];
  }

  const names: string[] = [];

  if (ts.isObjectBindingPattern(binding)) {
    for (const element of binding.elements) {
      names.push(...extractBindingNames(element.name));
    }
  } else if (ts.isArrayBindingPattern(binding)) {
    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) {
        continue; // Skip holes in array patterns like [a, , c]
      }
      names.push(...extractBindingNames(element.name));
    }
  }

  return names;
}

function isParameterOrLocalVariable(
  identifier: ts.Identifier,
  func: ts.FunctionLikeDeclaration,
  funcParams: Set<string>,
  checker: ts.TypeChecker,
): boolean {
  // Check if it's a function parameter
  if (funcParams.has(identifier.text)) {
    return true;
  }

  // Check if it's a local variable declared within the function
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol) {
    const declarations = symbol.getDeclarations() || [];
    for (const decl of declarations) {
      if (isDeclaredWithinFunction(decl, func)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Determines if a capture from a nested function should be added to the outer function's captures.
 * Filters out captures that are parameters or local variables of the outer function.
 *
 * For identifiers: Check if the identifier is a parameter or local variable of the outer function.
 * For property accesses: Check if the root identifier is a parameter or local variable.
 *   Example: If outer function has parameter `item` or local `const item = ...`, then inner
 *   function's capture of `item.name` should NOT be added to outer function's captures (since
 *   `item` belongs to the outer function's scope, not from further out).
 */
function shouldAddNestedCapture(
  capture: ts.Expression,
  outerFunc: ts.FunctionLikeDeclaration,
  funcParams: Set<string>,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isIdentifier(capture)) {
    return !isParameterOrLocalVariable(
      capture,
      outerFunc,
      funcParams,
      checker,
    );
  }

  if (ts.isPropertyAccessExpression(capture)) {
    // Property access: check if root identifier is a parameter or local variable
    // Walk down the chain to find the root: a.b.c -> a
    let rootExpr: ts.Expression = capture;
    while (ts.isPropertyAccessExpression(rootExpr)) {
      rootExpr = rootExpr.expression;
    }
    if (ts.isIdentifier(rootExpr)) {
      return !isParameterOrLocalVariable(
        rootExpr,
        outerFunc,
        funcParams,
        checker,
      );
    }
    // Root is not an identifier (e.g., computed property access) - include it
    return true;
  }

  // Other types of captures (e.g., element access, call expressions) - include them
  return true;
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

  function visit(node: ts.Node) {
    // For nested functions, recursively collect their captures too
    // Even though they have their own scope for parameters, they still
    // close over variables from outer scopes, and we need to know about
    // all such captures for the derive/handler transformation
    if (node !== func && isFunctionLikeDeclaration(node)) {
      const nestedCaptures = collectCaptures(node, checker);
      // Filter out captures that are parameters of the current function
      //
      // CRITICAL: We must filter based on root identifiers for property accesses.
      // Example: Outer map has parameter `item`, inner map uses `item.name`
      //   - Without this filtering: `item.name` gets added to outer params → collision with `element: item` → generates `item_1`
      //   - With this filtering: Recognizes `item` is outer param → filters out `item.name` → only `state` in outer params
      // This prevents spurious name collisions when nested callbacks reference outer parameters.
      const funcParams = new Set(
        func.parameters.flatMap((p) => extractBindingNames(p.name)),
      );

      for (const capture of nestedCaptures) {
        if (shouldAddNestedCapture(capture, func, funcParams, checker)) {
          captures.add(capture);
        }
      }
      // Don't visit children since we just recursively processed them
      return;
    }

    // For property access like state.discount, capture the whole expression
    if (ts.isPropertyAccessExpression(node)) {
      // If this is a method call, try to capture the object instead of the method
      // Example: state.counter.set() -> capture state.counter, not state.counter.set
      // But if the object is just an identifier (multiplier.get()), skip this and
      // let the identifier visitor handle it
      const methodTarget = getMethodCallTarget(node);
      if (methodTarget) {
        // Method call on a property access (e.g., state.counter.set())
        const captured = shouldCapturePropertyAccess(
          methodTarget,
          func,
          checker,
        );
        if (captured) {
          captures.add(captured);
          // Don't visit children
          return;
        }
      } else if (!isMethodCall(node)) {
        // Not a method call, capture the property access normally
        const captured = shouldCapturePropertyAccess(node, func, checker);
        if (captured) {
          captures.add(captured);
          // Don't visit children
          return;
        }
      }
      // For method calls on identifiers (multiplier.get()), don't capture the property access
      // The identifier will be captured separately
    }

    // For plain identifiers
    if (ts.isIdentifier(node)) {
      const captured = shouldCaptureIdentifier(node, func, checker);
      if (captured) {
        captures.add(captured);
      }
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
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  logger?: (message: string) => void,
): boolean {
  // Check if this is a property access expression with name "map"
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "map") return false;

  // Get the type of the target (what we're calling .map on)
  const target = node.expression.expression;
  const targetType = getTypeAtLocationWithFallback(
    target,
    checker,
    typeRegistry,
    logger,
  );
  if (!targetType) return false;

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

  let current: ts.Expression = target;

  // Walk back through call chain to find the origin
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    arrayMethods.includes(current.expression.name.text)
  ) {
    current = current.expression.expression;
  }

  // Check if origin is OpaqueRef<T[]> or Cell<T[]>
  const originType = getTypeAtLocationWithFallback(
    current,
    checker,
    typeRegistry,
    logger,
  );
  if (!originType) return false;

  return isOpaqueRefType(originType, checker) &&
    hasArrayTypeArgument(originType, checker);
}

function determineElementType(
  mapCall: ts.CallExpression,
  elemParam: ts.ParameterDeclaration | undefined,
  context: TransformationContext,
): { typeNode: ts.TypeNode; type?: ts.Type } {
  const { checker, factory } = context;
  const typeRegistry = context.options.typeRegistry;

  // Try explicit annotation
  const explicit = tryExplicitParameterType(elemParam, checker, typeRegistry);
  if (explicit) return explicit;

  // Try inference from map call
  const inferred = inferElementType(mapCall, context);
  if (inferred.type) {
    return {
      typeNode: registerTypeForNode(
        inferred.typeNode,
        inferred.type,
        typeRegistry,
      ),
      type: inferred.type,
    };
  }

  // Fallback: infer from the map call location itself
  const type = checker.getTypeAtLocation(mapCall);
  const typeNode = checker.typeToTypeNode(
    type,
    context.sourceFile,
    ts.NodeBuilderFlags.NoTruncation |
      ts.NodeBuilderFlags.UseStructuralFallback,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  return {
    typeNode: registerTypeForNode(typeNode, type, typeRegistry),
    type,
  };
}

/**
 * Build property assignments for captured variables from a capture tree.
 * Used by map, handler, and derive transformations to build params/input objects.
 */
function buildCapturePropertyAssignments(
  captureTree: Map<string, CaptureTreeNode>,
  factory: ts.NodeFactory,
): ts.PropertyAssignment[] {
  const properties: ts.PropertyAssignment[] = [];
  for (const [rootName, node] of captureTree) {
    properties.push(
      factory.createPropertyAssignment(
        createPropertyName(rootName, factory),
        buildHierarchicalParamsValue(node, rootName, factory),
      ),
    );
  }
  return properties;
}

/**
 * Build a TypeNode for the callback parameter and register property TypeNodes in typeRegistry.
 * Returns a TypeLiteral representing { element: T, index?: number, array?: T[], params: {...} }
 */
function buildCallbackParamTypeNode(
  mapCall: ts.CallExpression,
  elemParam: ts.ParameterDeclaration | undefined,
  indexParam: ts.ParameterDeclaration | undefined,
  arrayParam: ts.ParameterDeclaration | undefined,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.TypeNode {
  const { factory } = context;

  // 1. Determine element type
  const { typeNode: elemTypeNode } = determineElementType(
    mapCall,
    elemParam,
    context,
  );

  // 2. Build callback parameter properties
  const callbackParamProperties: ts.TypeElement[] = [
    factory.createPropertySignature(
      undefined,
      factory.createIdentifier("element"),
      undefined,
      elemTypeNode,
    ),
  ];

  // 3. Add optional index property if present
  if (indexParam) {
    callbackParamProperties.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier("index"),
        factory.createToken(ts.SyntaxKind.QuestionToken),
        factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      ),
    );
  }

  // 4. Add optional array property if present
  if (arrayParam) {
    // The array type is T[] where T is the element type
    const arrayTypeNode = factory.createArrayTypeNode(elemTypeNode);
    callbackParamProperties.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier("array"),
        factory.createToken(ts.SyntaxKind.QuestionToken),
        arrayTypeNode,
      ),
    );
  }

  // 5. Build params object type with hierarchical captures
  const paramsProperties = buildTypeElementsFromCaptureTree(
    captureTree,
    context,
  );

  // 6. Add params property
  callbackParamProperties.push(
    factory.createPropertySignature(
      undefined,
      factory.createIdentifier("params"),
      undefined,
      factory.createTypeLiteralNode(paramsProperties),
    ),
  );

  return factory.createTypeLiteralNode(callbackParamProperties);
}

/**
 * Infer the element type from an OpaqueRef<T[]> or Array<T> being mapped.
 * This is a thin wrapper around inferArrayElementType that extracts the array expression
 * from the map call.
 */
function inferElementType(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): { typeNode: ts.TypeNode; type?: ts.Type } {
  const { factory } = context;

  if (!ts.isPropertyAccessExpression(mapCall.expression)) {
    return {
      typeNode: factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    };
  }

  const arrayExpr = mapCall.expression.expression;
  return inferArrayElementType(arrayExpr, context);
}

/**
 * Build a TypeNode for the handler event parameter and register it in TypeRegistry.
 * If the callback has an explicit event type annotation, use it.
 * If there's no event parameter, use never (generates false schema).
 * Otherwise, infer from the parameter location (could be enhanced to infer from JSX context).
 */
function buildHandlerEventTypeNode(
  callback: ts.ArrowFunction,
  context: TransformationContext,
): ts.TypeNode {
  const { factory, checker } = context;
  const typeRegistry = context.options.typeRegistry;
  const eventParam = callback.parameters[0];

  // If no event parameter exists, use never type (will generate false schema)
  if (!eventParam) {
    const neverTypeNode = factory.createKeywordTypeNode(
      ts.SyntaxKind.NeverKeyword,
    );

    // Don't register a Type - the synthetic NeverKeyword TypeNode will be handled
    // by generateSchemaFromSyntheticTypeNode in the schema generator
    return neverTypeNode;
  }

  // Try explicit annotation
  const explicit = tryExplicitParameterType(eventParam, checker, typeRegistry);
  if (explicit) return explicit.typeNode;

  // Infer from parameter location
  const type = checker.getTypeAtLocation(eventParam);

  // Try to convert Type to TypeNode
  const typeNode = checker.typeToTypeNode(
    type,
    context.sourceFile,
    ts.NodeBuilderFlags.NoTruncation |
      ts.NodeBuilderFlags.UseStructuralFallback,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  return registerTypeForNode(typeNode, type, typeRegistry);
}

/**
 * Build a TypeNode for the handler state/params parameter and register it in TypeRegistry.
 * Reuses the same capture tree utilities as map closures.
 */
function buildHandlerStateTypeNode(
  captureTree: Map<string, CaptureTreeNode>,
  callback: ts.ArrowFunction,
  context: TransformationContext,
): ts.TypeNode {
  const { factory, checker } = context;
  const typeRegistry = context.options.typeRegistry;
  const stateParam = callback.parameters[1];

  // Try explicit annotation
  const explicit = tryExplicitParameterType(stateParam, checker, typeRegistry);
  if (explicit) return explicit.typeNode;

  // Fallback: build from captures (buildTypeElementsFromCaptureTree handles its own registration)
  const paramsProperties = buildTypeElementsFromCaptureTree(
    captureTree,
    context,
  );
  return factory.createTypeLiteralNode(paramsProperties);
}

/**
 * Check if map call is inside a derive/computed callback with a non-Cell OpaqueRef.
 * Returns true if we should skip transformation due to OpaqueRef unwrapping.
 */
function isInsideDeriveWithOpaqueRef(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const { checker } = context;
  const typeRegistry = context.options.typeRegistry;

  let node: ts.Node = mapCall;
  while (node.parent) {
    if (
      ts.isArrowFunction(node.parent) || ts.isFunctionExpression(node.parent)
    ) {
      const callback = node.parent;
      // Check if this callback's parent is a derive call
      if (callback.parent && ts.isCallExpression(callback.parent)) {
        const deriveCall = callback.parent;
        const callKind = detectCallKind(deriveCall, checker);

        // Check if this is a derive or computed call
        // Note: Even though ComputedTransformer runs first, callback nodes are reused,
        // so parent pointers may still point to the original 'computed' call
        const isDeriveOrComputed = callKind?.kind === "derive" ||
          (callKind?.kind === "builder" && callKind.builderName === "computed");

        if (
          isDeriveOrComputed &&
          ts.isPropertyAccessExpression(mapCall.expression)
        ) {
          // We're inside a derive callback - check if target is Cell or OpaqueRef
          const mapTarget = mapCall.expression.expression;

          const targetType = getTypeAtLocationWithFallback(
            mapTarget,
            checker,
            typeRegistry,
            context.options.logger,
          );

          if (targetType && isOpaqueRefType(targetType, checker)) {
            const kind = getCellKind(targetType, checker);
            // Only skip transformation for non-Cell OpaqueRefs
            // Cell<T[]>.map() should still transform even inside derive
            if (kind !== "cell") {
              return true;
            }
          }
        }
      }
    }
    node = node.parent;
  }

  return false;
}

/**
 * Find the closest JSX expression ancestor of a node.
 */
function findClosestJsxExpression(
  node: ts.Node,
): ts.JsxExpression | undefined {
  let current = node;
  while (current.parent) {
    if (ts.isJsxExpression(current.parent)) {
      return current.parent;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Check if a map call will be wrapped in a derive by the JSX transformer.
 * Returns true if wrapping will occur (meaning we should NOT transform the map).
 */
function willBeWrappedByJsx(
  mapCall: ts.CallExpression,
  closestJsxExpression: ts.JsxExpression,
  context: TransformationContext,
): boolean {
  // JSX expression must have an expression to analyze
  if (!closestJsxExpression.expression) {
    return false;
  }

  const analyze = createDataFlowAnalyzer(context.checker);

  // Case 1: Map is nested in a larger expression within the same JSX expression
  // Example: {list.length > 0 && list.map(...)}
  // Only check THIS expression for derive wrapping
  if (closestJsxExpression.expression !== mapCall) {
    const analysis = analyze(closestJsxExpression.expression);
    // Check if this will be wrapped in a derive (not just transformed in some other way)
    // Array-map calls have skip-call-rewrite hint, so they won't be wrapped in derive
    const willBeWrappedInDerive = analysis.requiresRewrite &&
      !(analysis.rewriteHint?.kind === "skip-call-rewrite" &&
        analysis.rewriteHint.reason === "array-map");
    return willBeWrappedInDerive;
  }

  // Case 2: Map IS the direct content of the JSX expression
  // Example: <div>{list.map(...)}</div>
  // Check if an ANCESTOR JSX expression will wrap this in a derive
  let node: ts.Node | undefined = closestJsxExpression.parent;
  while (node) {
    if (ts.isJsxExpression(node) && node.expression) {
      const analysis = analyze(node.expression);
      const willBeWrappedInDerive = analysis.requiresRewrite &&
        !(analysis.rewriteHint?.kind === "skip-call-rewrite" &&
          analysis.rewriteHint.reason === "array-map");
      if (willBeWrappedInDerive) {
        // An ancestor JSX expression will wrap this in a derive
        return true;
      }
    }
    node = node.parent;
  }

  // No ancestor will wrap in derive
  return false;
}

/**
 * Check if a map call should be transformed to mapWithPattern.
 * Returns false if the map will end up inside a derive (where the array is unwrapped).
 *
 * This happens when the map is nested inside a larger expression with opaque refs,
 * e.g., `list.length > 0 && list.map(...)` becomes `derive(list, list => ...)`
 *
 * Special case: Inside derive callbacks, Cell<T[]>.map() should still be transformed,
 * but OpaqueRef<T[]>.map() should not (OpaqueRefs are unwrapped in derive).
 */
function shouldTransformMap(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  // Early exit: Don't transform if inside derive with non-Cell OpaqueRef
  if (isInsideDeriveWithOpaqueRef(mapCall, context)) {
    return false;
  }

  // Find the closest containing JSX expression
  const closestJsxExpression = findClosestJsxExpression(mapCall);

  // If we didn't find a JSX expression, default to transforming
  // (this handles maps in regular statements like `const x = items.map(...)`)
  if (!closestJsxExpression || !closestJsxExpression.expression) {
    return true;
  }

  // Check if this expression or ancestors will be wrapped by JSX transformer
  return !willBeWrappedByJsx(mapCall, closestJsxExpression, context);
}

function createClosureTransformVisitor(
  context: TransformationContext,
): ts.Visitor {
  const { checker } = context;

  const visit: ts.Visitor = (node) => {
    if (ts.isJsxAttribute(node) && isEventHandlerJsxAttribute(node.name)) {
      const transformed = transformHandlerJsxAttribute(node, context, visit);
      if (transformed) {
        return transformed;
      }
    }

    if (
      ts.isCallExpression(node) &&
      isOpaqueRefArrayMapCall(
        node,
        checker,
        context.options.typeRegistry,
        context.options.logger,
      )
    ) {
      const callback = node.arguments[0];

      if (callback && isFunctionLikeExpression(callback)) {
        if (shouldTransformMap(node, context)) {
          return transformMapCallback(node, callback, context, visit);
        }
      }
    }

    // Derive closure transformation
    if (ts.isCallExpression(node) && isDeriveCall(node, context)) {
      const transformed = transformDeriveCall(node, context, visit);
      if (transformed) {
        return transformed;
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return visit;
}

function transformHandlerJsxAttribute(
  attribute: ts.JsxAttribute,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.JsxAttribute | undefined {
  const initializer = attribute.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) {
    return undefined;
  }

  const expression = initializer.expression;
  if (!expression) {
    return undefined;
  }

  const callback = unwrapArrowFunction(expression);
  if (!callback) {
    return undefined;
  }

  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  const captureExpressions = collectCaptures(callback, context.checker);
  const captureTree = groupCapturesByRoot(captureExpressions);

  const handlerCallback = createHandlerCallback(
    callback,
    transformedBody,
    captureTree,
    context,
  );

  const { factory } = context;

  // Build type information for handler params
  const eventTypeNode = buildHandlerEventTypeNode(callback, context);
  const stateTypeNode = buildHandlerStateTypeNode(
    captureTree,
    callback,
    context,
  );

  const handlerExpr = context.ctHelpers.getHelperExpr("handler");
  const handlerCall = factory.createCallExpression(
    handlerExpr,
    [eventTypeNode, stateTypeNode],
    [handlerCallback],
  );

  const paramProperties = buildCapturePropertyAssignments(captureTree, factory);

  const paramsObject = factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );

  const finalCall = factory.createCallExpression(
    handlerCall,
    undefined,
    [paramsObject],
  );

  const newInitializer = factory.createJsxExpression(
    initializer.dotDotDotToken,
    finalCall,
  );

  return factory.createJsxAttribute(attribute.name, newInitializer);
}

function createHandlerCallback(
  callback: ts.ArrowFunction,
  transformedBody: ts.ConciseBody,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.ArrowFunction {
  const { factory } = context;
  const usedBindingNames = new Set<string>();
  const rootNames = new Set<string>();
  for (const [rootName] of captureTree) {
    rootNames.add(rootName);
  }

  const eventParam = callback.parameters[0];
  const stateParam = callback.parameters[1];
  const extraParams = callback.parameters.slice(2);

  const normalizeParameter = (
    original: ts.ParameterDeclaration,
    name: ts.BindingName,
  ): ts.ParameterDeclaration =>
    factory.createParameterDeclaration(
      original.modifiers,
      original.dotDotDotToken,
      name,
      original.questionToken,
      original.type,
      original.initializer,
    );

  const eventParameter = eventParam
    ? normalizeParameter(
      eventParam,
      normalizeBindingName(eventParam.name, factory, usedBindingNames),
    )
    : (() => {
      const baseName = "__ct_handler_event";
      let candidate = baseName;
      let index = 1;
      while (rootNames.has(candidate)) {
        candidate = `${baseName}_${index++}`;
      }
      return factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(
          getUniqueIdentifier(candidate, usedBindingNames, {
            fallback: baseName,
          }),
        ),
        undefined,
        undefined,
        undefined,
      );
    })();

  const createBindingIdentifier = (name: string): ts.Identifier => {
    if (isSafeIdentifierText(name) && !usedBindingNames.has(name)) {
      usedBindingNames.add(name);
      return factory.createIdentifier(name);
    }
    const fallback = name.length > 0 ? name : "ref";
    const unique = getUniqueIdentifier(fallback, usedBindingNames, {
      fallback: "ref",
    });
    return factory.createIdentifier(unique);
  };

  const paramsBindings = createBindingElementsFromNames(
    captureTree.keys(),
    factory,
    createBindingIdentifier,
  );

  const paramsBindingPattern = factory.createObjectBindingPattern(
    paramsBindings,
  );

  let paramsBindingName: ts.BindingName;
  if (stateParam) {
    paramsBindingName = normalizeBindingName(
      stateParam.name,
      factory,
      usedBindingNames,
    );
  } else if (captureTree.size > 0) {
    paramsBindingName = paramsBindingPattern;
  } else {
    paramsBindingName = factory.createIdentifier(
      getUniqueIdentifier("__ct_handler_params", usedBindingNames, {
        fallback: "__ct_handler_params",
      }),
    );
  }

  const paramsParameter = stateParam
    ? normalizeParameter(stateParam, paramsBindingName)
    : factory.createParameterDeclaration(
      undefined,
      undefined,
      paramsBindingName,
      undefined,
      undefined,
      undefined,
    );

  const additionalParameters = extraParams.map((param) =>
    normalizeParameter(
      param,
      normalizeBindingName(param.name, factory, usedBindingNames),
    )
  );

  return factory.createArrowFunction(
    callback.modifiers,
    callback.typeParameters,
    [eventParameter, paramsParameter, ...additionalParameters],
    callback.type,
    callback.equalsGreaterThanToken,
    transformedBody,
  );
}

function unwrapArrowFunction(
  expression: ts.Expression,
): ts.ArrowFunction | undefined {
  if (ts.isArrowFunction(expression)) {
    return expression;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapArrowFunction(expression.expression);
  }
  return undefined;
}

/**
 * Create the final recipe call with params object.
 */
function createRecipeCallWithParams(
  mapCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  elemParam: ts.ParameterDeclaration | undefined,
  indexParam: ts.ParameterDeclaration | undefined,
  arrayParam: ts.ParameterDeclaration | undefined,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression {
  const { factory } = context;

  const bindingElements: ts.BindingElement[] = [];
  const usedBindingNames = new Set<string>();

  const createBindingIdentifier = (name: string): ts.Identifier => {
    return reserveIdentifier(name, usedBindingNames, factory);
  };

  const elementAnalysis = analyzeElementBinding(
    elemParam,
    captureTree,
    context,
    usedBindingNames,
    createBindingIdentifier,
  );
  const elementBindingName = elementAnalysis.bindingName;
  const elementPropertyName = ts.isIdentifier(elementBindingName) &&
      elementBindingName.text === "element"
    ? undefined
    : factory.createIdentifier("element");
  bindingElements.push(
    factory.createBindingElement(
      undefined,
      elementPropertyName,
      elementBindingName,
      undefined,
    ),
  );

  if (indexParam) {
    bindingElements.push(
      factory.createBindingElement(
        undefined,
        factory.createIdentifier("index"),
        normalizeBindingName(indexParam.name, factory, usedBindingNames),
        undefined,
      ),
    );
  }

  if (arrayParam) {
    bindingElements.push(
      factory.createBindingElement(
        undefined,
        factory.createIdentifier("array"),
        normalizeBindingName(arrayParam.name, factory, usedBindingNames),
        undefined,
      ),
    );
  }

  const paramsBindings = createBindingElementsFromNames(
    captureTree.keys(),
    factory,
    createBindingIdentifier,
  );

  const paramsPattern = factory.createObjectBindingPattern(paramsBindings);

  bindingElements.push(
    factory.createBindingElement(
      undefined,
      factory.createIdentifier("params"),
      paramsPattern,
      undefined,
    ),
  );

  const destructuredParam = createParameterFromBindings(
    bindingElements,
    factory,
  );

  const visitedAliases: ComputedAliasInfo[] = elementAnalysis
    .computedAliases.map((info) => {
      const keyExpression = ts.visitNode(
        info.keyExpression,
        visitor,
        ts.isExpression,
      ) ?? info.keyExpression;
      return { ...info, keyExpression };
    });

  const rewrittenBody = rewriteCallbackBody(
    transformedBody,
    {
      bindingName: elementAnalysis.bindingName,
      elementIdentifier: elementAnalysis.elementIdentifier,
      destructureStatement: elementAnalysis.destructureStatement,
      computedAliases: visitedAliases,
    },
    context,
  );

  const newCallback = factory.createArrowFunction(
    callback.modifiers,
    callback.typeParameters,
    [destructuredParam],
    callback.type,
    ts.isArrowFunction(callback)
      ? callback.equalsGreaterThanToken
      : factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    rewrittenBody,
  );

  context.markAsMapCallback(newCallback);

  const callbackParamTypeNode = buildCallbackParamTypeNode(
    mapCall,
    elemParam,
    indexParam,
    arrayParam,
    captureTree,
    context,
  );

  const recipeExpr = context.ctHelpers.getHelperExpr("recipe");
  const recipeCall = factory.createCallExpression(
    recipeExpr,
    [callbackParamTypeNode],
    [newCallback],
  );

  const paramProperties = buildCapturePropertyAssignments(captureTree, factory);

  const paramsObject = factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );

  if (!ts.isPropertyAccessExpression(mapCall.expression)) {
    throw new Error(
      "Expected mapCall.expression to be a PropertyAccessExpression",
    );
  }
  const mapWithPatternAccess = factory.createPropertyAccessExpression(
    mapCall.expression.expression,
    factory.createIdentifier("mapWithPattern"),
  );

  return factory.createCallExpression(
    mapWithPatternAccess,
    mapCall.typeArguments,
    [recipeCall, paramsObject],
  );
}

/**
 * Transform a map callback for OpaqueRef arrays.
 * Always transforms to use recipe + mapWithPattern, even with no captures,
 * to ensure callback parameters become opaque.
 */
function transformMapCallback(
  mapCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression {
  const { checker } = context;

  // Collect captured variables from the callback
  const captureExpressions = collectCaptures(callback, checker);
  const captureTree = groupCapturesByRoot(captureExpressions);

  // Get callback parameters
  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const indexParam = originalParams[1]; // May be undefined
  const arrayParam = originalParams[2]; // May be undefined

  // IMPORTANT: First, recursively transform any nested map callbacks BEFORE we change
  // parameter names. This ensures nested callbacks can properly detect captures from
  // parent callback scope. Reuse the same visitor for consistency.
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Create the final recipe call with params
  return createRecipeCallWithParams(
    mapCall,
    callback,
    transformedBody,
    elemParam,
    indexParam,
    arrayParam,
    captureTree,
    context,
    visitor,
  );
}

// ============================================================================
// DERIVE CLOSURE TRANSFORMATION
// ============================================================================

/**
 * Check if a call expression is a derive() call from commontools
 */
function isDeriveCall(
  node: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const callKind = detectCallKind(node, context.checker);
  return callKind?.kind === "derive";
}

/**
 * Extract the callback function from a derive call.
 * Derive has two signatures:
 * - 2-arg: derive(input, callback)
 * - 4-arg: derive(inputSchema, resultSchema, input, callback)
 */
function extractDeriveCallback(
  deriveCall: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const args = deriveCall.arguments;

  // 2-arg form: callback is at index 1
  if (args.length === 2) {
    const callback = args[1];
    if (callback && isFunctionLikeExpression(callback)) {
      return callback;
    }
  }

  // 4-arg form: callback is at index 3
  if (args.length === 4) {
    const callback = args[3];
    if (callback && isFunctionLikeExpression(callback)) {
      return callback;
    }
  }

  return undefined;
}

/**
 * Resolve capture name collisions with the original input parameter name.
 * If a capture has the same name as originalInputParamName, rename it (e.g., multiplier -> multiplier_1).
 * Returns a mapping from original capture names to their potentially renamed versions.
 */
function resolveDeriveCaptureNameCollisions(
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
): Map<string, string> {
  const captureNameMap = new Map<string, string>();
  const usedNames = new Set<string>([originalInputParamName]);

  for (const [captureName] of captureTree) {
    if (captureName === originalInputParamName) {
      // Collision detected - rename the capture
      let renamed = `${captureName}_1`;
      let suffix = 1;
      while (usedNames.has(renamed) || captureTree.has(renamed)) {
        suffix++;
        renamed = `${captureName}_${suffix}`;
      }
      captureNameMap.set(captureName, renamed);
      usedNames.add(renamed);
    } else {
      // No collision - use original name
      captureNameMap.set(captureName, captureName);
      usedNames.add(captureName);
    }
  }

  return captureNameMap;
}

/**
 * Build the merged input object containing both the original input and captures.
 * Example: {value, multiplier} where value is the original input and multiplier is a capture.
 *
 * When hadZeroParameters is true, skip the original input and only include captures.
 * This handles the case where user wrote derive({}, () => ...) and we only need captures.
 */
function buildDeriveInputObject(
  originalInput: ts.Expression,
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  factory: ts.NodeFactory,
  hadZeroParameters: boolean,
): ts.ObjectLiteralExpression {
  const properties: ts.ObjectLiteralElementLike[] = [];

  // Add the original input as a property UNLESS callback had zero parameters
  // When hadZeroParameters, we only include captures
  if (!hadZeroParameters) {
    // Use shorthand if the original input is a simple identifier matching the param name
    if (
      ts.isIdentifier(originalInput) &&
      originalInput.text === originalInputParamName
    ) {
      properties.push(
        factory.createShorthandPropertyAssignment(originalInput, undefined),
      );
    } else {
      properties.push(
        factory.createPropertyAssignment(
          createPropertyName(originalInputParamName, factory),
          originalInput,
        ),
      );
    }
  }

  // Add captures with potentially renamed property names
  for (const [originalName, node] of captureTree) {
    const propertyName = captureNameMap.get(originalName) ?? originalName;
    properties.push(
      factory.createPropertyAssignment(
        createPropertyName(propertyName, factory),
        buildHierarchicalParamsValue(node, originalName, factory),
      ),
    );
  }

  return factory.createObjectLiteralExpression(
    properties,
    properties.length > 1,
  );
}

/**
 * Rewrite the callback body to use renamed capture identifiers.
 * For example, if `multiplier` was renamed to `multiplier_1`, replace all
 * references to the captured `multiplier` with `multiplier_1`.
 */
function rewriteCaptureReferences(
  body: ts.ConciseBody,
  captureNameMap: Map<string, string>,
  factory: ts.NodeFactory,
): ts.ConciseBody {
  // Build a reverse map: original capture name -> list of renamed names that should be substituted
  const substitutions = new Map<string, string>();
  for (const [originalName, renamedName] of captureNameMap) {
    if (originalName !== renamedName) {
      substitutions.set(originalName, renamedName);
    }
  }

  if (substitutions.size === 0) {
    return body; // No substitutions needed
  }

  const visitor = (node: ts.Node): ts.Node => {
    // Only substitute root-level identifiers that match captured variable names
    // Don't substitute property names or nested references
    if (ts.isIdentifier(node)) {
      const substituteName = substitutions.get(node.text);
      if (substituteName) {
        return factory.createIdentifier(substituteName);
      }
    }

    return ts.visitEachChild(node, visitor, undefined);
  };

  return ts.visitNode(body, visitor) as ts.ConciseBody;
}

/**
 * Create the derive callback with parameter aliasing to preserve user's parameter name.
 * Example: ({value: v, multiplier}) => v * multiplier
 *
 * When hadZeroParameters is true, build a parameter from just the captures (no original input).
 * This handles the case where user wrote derive({}, () => ...) with captures.
 */
function createDeriveCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  context: TransformationContext,
  hadZeroParameters: boolean,
): ts.ArrowFunction | ts.FunctionExpression {
  const { factory } = context;
  const usedBindingNames = new Set<string>();

  // Get the original parameter
  const originalParam = callback.parameters[0];
  if (!originalParam) {
    // No parameter - if there are captures, build parameter from captures only
    if (hadZeroParameters && captureTree.size > 0) {
      // Build binding elements from just the captures (no original input)
      const createBindingIdentifier = (name: string): ts.Identifier => {
        return reserveIdentifier(name, usedBindingNames, factory);
      };

      const bindingElements = createBindingElementsFromNames(
        captureTree.keys(),
        factory,
        createBindingIdentifier,
      );

      const destructuredParam = factory.createParameterDeclaration(
        undefined, // modifiers
        undefined, // dotDotDotToken
        factory.createObjectBindingPattern(bindingElements),
        undefined, // questionToken
        undefined, // type
        undefined, // initializer
      );

      return ts.isArrowFunction(callback)
        ? factory.createArrowFunction(
          callback.modifiers,
          callback.typeParameters,
          [destructuredParam],
          undefined, // No return type - rely on inference
          callback.equalsGreaterThanToken,
          transformedBody,
        )
        : factory.createFunctionExpression(
          callback.modifiers,
          callback.asteriskToken,
          callback.name,
          callback.typeParameters,
          [destructuredParam],
          undefined, // No return type - rely on inference
          transformedBody as ts.Block,
        );
    }

    // No parameter and no captures (or not hadZeroParameters) - shouldn't happen, but handle gracefully
    return ts.isArrowFunction(callback)
      ? factory.createArrowFunction(
        callback.modifiers,
        callback.typeParameters,
        [],
        callback.type,
        callback.equalsGreaterThanToken,
        transformedBody,
      )
      : factory.createFunctionExpression(
        callback.modifiers,
        callback.asteriskToken,
        callback.name,
        callback.typeParameters,
        [],
        callback.type,
        transformedBody as ts.Block,
      );
  }

  // Build the binding elements for the destructured parameter
  const bindingElements: ts.BindingElement[] = [];

  // Create binding for original input with alias to preserve user's parameter name
  const originalParamBinding = normalizeBindingName(
    originalParam.name,
    factory,
    usedBindingNames,
  );

  bindingElements.push(
    factory.createBindingElement(
      undefined,
      factory.createIdentifier(originalInputParamName), // Property name
      originalParamBinding, // Binding name (what it's called in the function body)
      originalParam.initializer, // Preserve default value if present
    ),
  );

  // Add bindings for captures using the potentially renamed property names
  const createBindingIdentifier = (name: string): ts.Identifier => {
    return reserveIdentifier(name, usedBindingNames, factory);
  };

  // Create binding elements using the renamed capture names
  const renamedCaptureNames = Array.from(captureTree.keys()).map(
    (originalName) => captureNameMap.get(originalName) ?? originalName,
  );

  bindingElements.push(
    ...createBindingElementsFromNames(
      renamedCaptureNames,
      factory,
      createBindingIdentifier,
    ),
  );

  // Create the parameter with object binding pattern
  const parameter = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(bindingElements),
    undefined,
    undefined, // No type annotation - rely on inference
    undefined,
  );

  // Rewrite the body to use renamed capture identifiers
  const rewrittenBody = rewriteCaptureReferences(
    transformedBody,
    captureNameMap,
    factory,
  );

  // Create the new callback
  if (ts.isArrowFunction(callback)) {
    return factory.createArrowFunction(
      callback.modifiers,
      callback.typeParameters,
      [parameter],
      undefined, // No return type - rely on inference
      callback.equalsGreaterThanToken,
      rewrittenBody,
    );
  } else {
    return factory.createFunctionExpression(
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      [parameter],
      undefined, // No return type - rely on inference
      rewrittenBody as ts.Block,
    );
  }
}

/**
 * Build schema TypeNode for the merged input object.
 * Creates an object schema with properties for input and all captures.
 *
 * When hadZeroParameters is true, skip the input and only include captures.
 */
function buildDeriveInputSchema(
  originalInputParamName: string,
  originalInput: ts.Expression,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  context: TransformationContext,
  hadZeroParameters: boolean,
): ts.TypeNode {
  const { factory, checker } = context;

  // Build type elements for the object schema
  const typeElements: ts.TypeElement[] = [];

  // Add type element for original input UNLESS callback had zero parameters
  if (!hadZeroParameters) {
    // Add type element for original input using the helper function
    const inputTypeNode = expressionToTypeNode(originalInput, context);

    // Check if the original input is an optional property access (e.g., config.multiplier where multiplier?: number)
    let questionToken: ts.QuestionToken | undefined = undefined;
    if (ts.isPropertyAccessExpression(originalInput)) {
      if (isOptionalPropertyAccess(originalInput, checker)) {
        questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
      }
    }

    typeElements.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(originalInputParamName),
        questionToken,
        inputTypeNode,
      ),
    );
  }

  // Add type elements for captures using the existing helper
  const captureTypeElements = buildTypeElementsFromCaptureTree(
    captureTree,
    context,
  );

  // Rename the property signatures if there are collisions
  for (const typeElement of captureTypeElements) {
    if (
      ts.isPropertySignature(typeElement) && ts.isIdentifier(typeElement.name)
    ) {
      const originalName = typeElement.name.text;
      const renamedName = captureNameMap.get(originalName) ?? originalName;

      if (renamedName !== originalName) {
        // Create a new property signature with the renamed identifier
        typeElements.push(
          factory.createPropertySignature(
            typeElement.modifiers,
            factory.createIdentifier(renamedName),
            typeElement.questionToken,
            typeElement.type,
          ),
        );
      } else {
        // No renaming needed
        typeElements.push(typeElement);
      }
    } else {
      // Not a simple property signature, keep as-is
      typeElements.push(typeElement);
    }
  }

  // Create object type literal
  return factory.createTypeLiteralNode(typeElements);
}

/**
 * Transform a derive call that has closures in its callback.
 * Converts: derive(value, (v) => v * multiplier.get())
 * To: derive(inputSchema, resultSchema, {value, multiplier}, ({value: v, multiplier}) => v * multiplier)
 */
function transformDeriveCall(
  deriveCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  const { factory, checker } = context;

  // Extract callback
  const callback = extractDeriveCallback(deriveCall);
  if (!callback) {
    return undefined;
  }

  // Collect captures
  const captureExpressions = collectCaptures(callback, checker);
  if (captureExpressions.size === 0) {
    // No captures - no transformation needed
    return undefined;
  }

  const captureTree = groupCapturesByRoot(captureExpressions);

  // Recursively transform the callback body first
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Determine original input and parameter name
  const args = deriveCall.arguments;
  let originalInput: ts.Expression | undefined;

  if (args.length === 2) {
    // 2-arg form: derive(input, callback)
    originalInput = args[0];
  } else if (args.length === 4) {
    // 4-arg form: derive(inputSchema, resultSchema, input, callback)
    originalInput = args[2];
  } else {
    // Invalid number of arguments
    return undefined;
  }

  // Ensure we have a valid input expression
  if (!originalInput) {
    return undefined;
  }

  // Determine parameter name for the original input
  // Extract the identifier name from the input expression (e.g., "value" from `value`)
  // This becomes the property name in the merged object
  let originalInputParamName = "input"; // Fallback for complex expressions

  if (ts.isIdentifier(originalInput)) {
    // Simple identifier input like `value` - use its name
    originalInputParamName = originalInput.text;
  } else if (ts.isPropertyAccessExpression(originalInput)) {
    // Property access like `state.value` - use the property name
    originalInputParamName = originalInput.name.text;
  }
  // For other expressions (object literals, etc.), use "input" fallback

  // Check if callback originally had zero parameters
  // In this case, we don't need to preserve the input - just use captures
  const hadZeroParameters = callback.parameters.length === 0;

  // Resolve capture name collisions with the original input parameter name
  const captureNameMap = resolveDeriveCaptureNameCollisions(
    originalInputParamName,
    captureTree,
  );

  // Build merged input object
  const mergedInput = buildDeriveInputObject(
    originalInput,
    originalInputParamName,
    captureTree,
    captureNameMap,
    factory,
    hadZeroParameters,
  );

  // Create new callback with parameter aliasing
  const newCallback = createDeriveCallback(
    callback,
    transformedBody,
    originalInputParamName,
    captureTree,
    captureNameMap,
    context,
    hadZeroParameters,
  );

  // Build TypeNodes for schema generation (similar to handlers/maps pattern)
  // These will be registered in typeRegistry for SchemaInjectionTransformer to use
  const inputTypeNode = buildDeriveInputSchema(
    originalInputParamName,
    originalInput,
    captureTree,
    captureNameMap,
    context,
    hadZeroParameters,
  );

  // Infer result type from callback
  // SchemaInjectionTransformer will use this to generate the result schema
  const signature = context.checker.getSignatureFromDeclaration(callback);
  let resultTypeNode: ts.TypeNode | undefined;

  if (callback.type) {
    // Explicit return type annotation - use it
    resultTypeNode = callback.type;
  } else if (signature) {
    // Infer from callback signature
    const returnType = signature.getReturnType();
    resultTypeNode = context.checker.typeToTypeNode(
      returnType,
      context.sourceFile,
      ts.NodeBuilderFlags.NoTruncation |
        ts.NodeBuilderFlags.UseStructuralFallback,
    );
  }

  // Build the derive call expression
  // Output 2-arg form with type arguments - SchemaInjectionTransformer will convert to 4-arg form with schemas
  const deriveExpr = context.ctHelpers.getHelperExpr("derive");

  const newDeriveCall = factory.createCallExpression(
    deriveExpr,
    resultTypeNode ? [inputTypeNode, resultTypeNode] : [inputTypeNode], // Type arguments
    [mergedInput, newCallback], // Runtime arguments
  );

  return newDeriveCall;
}

function transformClosures(context: TransformationContext): ts.SourceFile {
  const { sourceFile } = context;

  const visitor = createClosureTransformVisitor(context);

  return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
}
