import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  getCellKind,
  isOpaqueRefType,
} from "../../transformers/opaque-ref/opaque-ref.ts";
import {
  detectCallKind,
  getTypeAtLocationWithFallback,
  isFunctionLikeExpression,
} from "../../ast/mod.ts";
import { buildHierarchicalParamsValue } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  normalizeBindingName,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import { analyzeElementBinding, rewriteCallbackBody } from "./map-utils.ts";
import type { ComputedAliasInfo } from "./map-utils.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { RecipeBuilder } from "../utils/recipe-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";

export class MapStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) && isOpaqueRefArrayMapCall(
      node,
      context.checker,
      context.options.typeRegistry,
      context.options.logger,
    );
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;

    const callback = node.arguments[0];
    if (callback && isFunctionLikeExpression(callback)) {
      if (shouldTransformMap(node, context)) {
        return transformMapCallback(node, callback, context, visitor);
      }
    }
    return undefined;
  }
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
    return (type as ts.UnionType).types.some((t: ts.Type) =>
      hasArrayTypeArgument(t, checker)
    );
  }

  // Handle intersections - check if any member has an array type argument
  if (type.flags & ts.TypeFlags.Intersection) {
    return (type as ts.IntersectionType).types.some((t: ts.Type) =>
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
export function isOpaqueRefArrayMapCall(
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
  if (!targetType) {
    return false;
  }

  // Special case: If target is a derive call, always treat .map() as needing transformation
  // Rationale: derive() returns OpaqueRef<T> where T is the callback's return type.
  // For synthetic derive calls, we can't construct the OpaqueRef<T> wrapper type to register,
  // so we register the callback's return type instead. This means type-based detection
  // (isOpaqueRefType + hasArrayTypeArgument) won't recognize it, so we explicitly check
  // for derive calls. Since derive() always returns opaque values, if we're calling .map()
  // on it, it must be an array at runtime (otherwise the code would crash), so we should
  // transform to mapWithPattern.
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, checker);
    if (callKind?.kind === "derive") {
      return true;
    }
  }

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
  if (!originType) {
    return false;
  }

  return isOpaqueRefType(originType, checker) &&
    hasArrayTypeArgument(originType, checker);
}

/**
 * Build property assignments for captured variables from a capture tree.
 * Used by map, handler, and derive transformations to build params/input objects.
 */
export function buildCapturePropertyAssignments(
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
 * Walk back through array method chains to find the origin expression.
 * For example: items.filter(...).slice(...).map(...) -> items
 */
function getMethodChainOrigin(mapTarget: ts.Expression): ts.Expression {
  const arrayMethods = [
    "filter",
    "slice",
    "concat",
    "reverse",
    "sort",
    "flat",
    "flatMap",
  ];

  let current: ts.Expression = mapTarget;

  // Walk back through call chain to find the origin
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    arrayMethods.includes(current.expression.name.text)
  ) {
    current = current.expression.expression;
  }

  return current;
}

/**
 * Find the root identifier of an expression.
 * For example: item.tags -> item, items[0].name -> items
 */
function findRootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let current: ts.Expression = expr;
  while (true) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    // For call expressions, we can't determine the root identifier
    // (e.g., getItems().filter(...).map(...))
    return undefined;
  }
}

/**
 * Check if a declaration is a function parameter or a binding element within a parameter.
 * This handles both simple params like `(x)` and destructured params like `({ x, y })`.
 */
function isParameterOrBindingElement(
  declaration: ts.Declaration,
): boolean {
  if (ts.isParameter(declaration)) return true;
  if (ts.isBindingElement(declaration)) {
    // Check if this binding element is part of a parameter's binding pattern
    let current: ts.Node | undefined = declaration.parent;
    while (current) {
      if (ts.isParameter(current)) return true;
      if (
        ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)
      ) {
        current = current.parent;
        continue;
      }
      break;
    }
  }
  return false;
}

/**
 * Trace a symbol to find what kind of callback defined it as a parameter.
 * Returns the innermost callback boundary that defines this value.
 *
 * This is the key to unified handling of both:
 * - Nested maps inside mapWithPattern (Berni's case) -> returns "array-map"
 * - Filter-map chains inside derive (my case) -> returns "derive"
 */
function getDefiningCallKind(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): "array-map" | "derive" | "builder" | undefined {
  const declarations = symbol.getDeclarations();
  if (!declarations) return undefined;

  for (const declaration of declarations) {
    // Handle both direct parameters and binding elements in destructured parameters
    if (!isParameterOrBindingElement(declaration)) continue;

    // Find the containing function
    let functionNode: ts.Node | undefined = declaration.parent;
    while (functionNode && !ts.isFunctionLike(functionNode)) {
      functionNode = functionNode.parent;
    }
    if (!functionNode) continue;

    // Find the call expression this function is an argument to
    let candidate: ts.Node | undefined = functionNode.parent;
    while (candidate && !ts.isCallExpression(candidate)) {
      candidate = candidate.parent;
    }
    if (!candidate || !ts.isCallExpression(candidate)) continue;

    const callKind = detectCallKind(candidate, checker);
    if (callKind?.kind === "array-map") {
      return "array-map";
    }
    if (callKind?.kind === "derive") {
      return "derive";
    }
    if (
      callKind?.kind === "builder" &&
      callKind.builderName === "computed"
    ) {
      // computed() is similar to derive() - it unwraps its callback params
      return "derive";
    }
    if (callKind?.kind === "builder") {
      return "builder";
    }
  }

  return undefined;
}

/**
 * Check if we're inside a derive/computed callback.
 * This is used to detect when captured values will be unwrapped.
 */
function isInsideDeriveCallback(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const callback = current;
      if (callback.parent && ts.isCallExpression(callback.parent)) {
        const callKind = detectCallKind(callback.parent, checker);
        const isDeriveOrComputed = callKind?.kind === "derive" ||
          (callKind?.kind === "builder" && callKind.builderName === "computed");
        if (isDeriveOrComputed) {
          return true;
        }
      }
    }
    current = current.parent;
  }
  return false;
}

/**
 * Determine if a .map() call should skip transformation based on value-origin tracking.
 *
 * This unified approach handles:
 * 1. Nested maps inside mapWithPattern (where values are still opaque) -> TRANSFORM
 * 2. Filter-map chains inside derive (where values are unwrapped) -> DON'T TRANSFORM
 * 3. Captured values inside derive (where OpaqueRef values are unwrapped) -> DON'T TRANSFORM
 *
 * The key insight is tracing where the .map() target value originated:
 * - If from array-map (mapWithPattern) param -> still opaque -> TRANSFORM
 * - If from derive param + method chain -> plain JS array -> DON'T TRANSFORM
 * - If from derive param directly -> check Cell vs OpaqueRef type
 * - If from builder param BUT inside derive -> captured value unwrapped -> check type
 */
function shouldSkipMapTransformation(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const { checker } = context;
  const typeRegistry = context.options.typeRegistry;

  if (!ts.isPropertyAccessExpression(mapCall.expression)) {
    return false;
  }

  const mapTarget = mapCall.expression.expression;

  // Walk method chains to find origin (e.g., prefs.filter(...).map(...) -> prefs)
  const origin = getMethodChainOrigin(mapTarget);
  const hasMethodChain = origin !== mapTarget;

  // Find root identifier of the origin
  const rootId = findRootIdentifier(origin);
  if (!rootId) {
    // Can't determine root (e.g., getItems().filter(...).map(...) or derive(...).map(...))
    // Only apply type-based skip if we're inside a derive callback
    // (where captured values get unwrapped)
    if (isInsideDeriveCallback(mapCall, checker)) {
      return shouldSkipBasedOnType(mapTarget, checker, typeRegistry, context);
    }
    // Not inside derive - allow transformation (derive(...).map() should transform)
    return false;
  }

  // Get the symbol for the root identifier
  const rootSymbol = checker.getSymbolAtLocation(rootId);
  if (!rootSymbol) {
    // Same logic: only skip if inside derive callback
    if (isInsideDeriveCallback(mapCall, checker)) {
      return shouldSkipBasedOnType(mapTarget, checker, typeRegistry, context);
    }
    return false;
  }

  // Find what kind of callback defined this identifier as a parameter
  const definingKind = getDefiningCallKind(rootSymbol, checker);

  if (definingKind === "array-map") {
    // Value originated from mapWithPattern callback param -> still opaque at runtime
    // ALWAYS transform, regardless of any surrounding derives
    return false;
  }

  if (definingKind === "derive") {
    // Value originated from derive callback param -> unwrapped at runtime
    if (hasMethodChain) {
      // Method chain on unwrapped array produces plain JS array
      // DON'T transform - plain arrays don't have mapWithPattern
      return true;
    }

    // Direct map on derive param - check Cell vs OpaqueRef type
    // Cell<T[]>.map() should transform, OpaqueRef<T[]>.map() should not
    return shouldSkipBasedOnType(mapTarget, checker, typeRegistry, context);
  }

  if (definingKind === "builder") {
    // Value from builder (recipe/pattern/handler) param - these are OpaqueRef
    // BUT if we're inside a derive callback, this value will be captured and unwrapped
    if (isInsideDeriveCallback(mapCall, checker)) {
      // Inside derive - captured values are unwrapped
      // Check type to determine if Cell (still needs transform) or OpaqueRef (skip)
      return shouldSkipBasedOnType(mapTarget, checker, typeRegistry, context);
    }
    // Not inside derive - builder params are still opaque, transform
    return false;
  }

  // Couldn't determine origin from callback parameter
  // Only apply type-based skip if we're inside a derive callback
  // (where captured values get unwrapped)
  if (isInsideDeriveCallback(mapCall, checker)) {
    return shouldSkipBasedOnType(mapTarget, checker, typeRegistry, context);
  }

  // Not inside derive and can't determine origin - don't skip, allow transformation
  return false;
}

/**
 * Type-based fallback for determining if map transformation should be skipped.
 * Used when value-origin tracking can't determine the source.
 */
function shouldSkipBasedOnType(
  mapTarget: ts.Expression,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  context: TransformationContext,
): boolean {
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

  return false;
}

/**
 * Check if a map call should be transformed to mapWithPattern.
 *
 * Uses value-origin tracking to determine if the .map() target:
 * - Originated from mapWithPattern callback -> still opaque -> TRANSFORM
 * - Originated from derive callback + method chain -> plain JS array -> DON'T TRANSFORM
 * - Originated from derive callback directly -> check Cell vs OpaqueRef type
 */
function shouldTransformMap(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  // Use value-origin tracking to determine if we should skip transformation
  if (shouldSkipMapTransformation(mapCall, context)) {
    return false;
  }

  return true;
}

/**
 * Create the final recipe call with params object.
 */
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
  const usedBindingNames = new Set<string>();

  const createBindingIdentifier = (name: string): ts.Identifier => {
    return reserveIdentifier(name, usedBindingNames, factory);
  };

  // Analyze element binding to handle computed aliases
  const elementAnalysis = analyzeElementBinding(
    elemParam,
    captureTree,
    context,
    usedBindingNames,
    createBindingIdentifier,
  );

  // Filter out computed aliases from params - they'll be declared as local consts instead
  const computedAliasNames = new Set(
    elementAnalysis.computedAliases.map((alias) => alias.aliasName),
  );
  const filteredCaptureTree = new Map(
    Array.from(captureTree.entries()).filter(
      ([key]) => !computedAliasNames.has(key),
    ),
  );

  // Initialize RecipeBuilder
  const builder = new RecipeBuilder(context);
  builder.registerUsedNames(usedBindingNames);
  builder.setCaptureTree(filteredCaptureTree);

  // Add element parameter
  builder.addParameter(
    "element",
    elementAnalysis.bindingName,
    elementAnalysis.bindingName.kind === ts.SyntaxKind.Identifier &&
      elementAnalysis.bindingName.text === "element"
      ? undefined
      : "element",
  );

  // Add index parameter if present
  if (indexParam) {
    builder.addParameter(
      "index",
      normalizeBindingName(indexParam.name, factory, usedBindingNames),
    );
  }

  // Add array parameter if present
  if (arrayParam) {
    builder.addParameter(
      "array",
      normalizeBindingName(arrayParam.name, factory, usedBindingNames),
    );
  }

  // Rewrite body to handle computed aliases
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

  // Build the new callback
  const newCallback = builder.buildCallback(callback, rewrittenBody, "params");
  context.markAsMapCallback(newCallback);

  // Build schema using SchemaFactory
  const schemaFactory = new SchemaFactory(context);
  const callbackParamTypeNode = schemaFactory.createMapCallbackSchema(
    mapCall,
    elemParam,
    indexParam,
    arrayParam,
    filteredCaptureTree,
  );

  // Infer result type
  const { checker } = context;
  const typeRegistry = context.options.typeRegistry;
  let resultTypeNode: ts.TypeNode | undefined;

  // Check for explicit return type annotation
  if (callback.type) {
    resultTypeNode = callback.type;
    // Ensure type is registered if possible
    if (typeRegistry) {
      const type = getTypeAtLocationWithFallback(
        callback.type,
        checker,
        typeRegistry,
      );
      if (type) {
        typeRegistry.set(callback.type, type);
      }
    }
  } else {
    // Infer from callback signature
    const signature = checker.getSignatureFromDeclaration(callback);
    if (signature) {
      const resultType = signature.getReturnType();
      const isTypeParam = (resultType.flags & ts.TypeFlags.TypeParameter) !== 0;

      if (!isTypeParam) {
        resultTypeNode = checker.typeToTypeNode(
          resultType,
          context.sourceFile,
          ts.NodeBuilderFlags.NoTruncation |
            ts.NodeBuilderFlags.UseStructuralFallback,
        );

        if (resultTypeNode && typeRegistry) {
          typeRegistry.set(resultTypeNode, resultType);
        }
      }
    }
  }

  // Create recipe call
  const recipeExpr = context.ctHelpers.getHelperExpr("recipe");
  const typeArgs = [callbackParamTypeNode];
  if (resultTypeNode) {
    typeArgs.push(resultTypeNode);
  }

  const recipeCall = factory.createCallExpression(
    recipeExpr,
    typeArgs,
    [newCallback],
  );

  // Create params object
  const paramProperties = buildCapturePropertyAssignments(
    filteredCaptureTree,
    factory,
  );
  const paramsObject = factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );

  if (!ts.isPropertyAccessExpression(mapCall.expression)) {
    throw new Error(
      "Expected mapCall.expression to be a PropertyAccessExpression",
    );
  }

  // Visit the array expression
  const visitedArrayExpr = ts.visitNode(
    mapCall.expression.expression,
    visitor,
    ts.isExpression,
  ) ?? mapCall.expression.expression;

  const mapWithPatternAccess = factory.createPropertyAccessExpression(
    visitedArrayExpr,
    factory.createIdentifier("mapWithPattern"),
  );

  const args: ts.Expression[] = [recipeCall, paramsObject];
  if (mapCall.arguments.length > 1) {
    const thisArg = ts.visitNode(
      mapCall.arguments[1],
      visitor,
      ts.isExpression,
    );
    if (thisArg) {
      args.push(thisArg);
    }
  }

  return factory.createCallExpression(
    mapWithPatternAccess,
    mapCall.typeArguments,
    args,
  );
}

/**
 * Transform a map callback for OpaqueRef arrays.
 * Always transforms to use recipe + mapWithPattern, even with no captures,
 * to ensure callback parameters become opaque.
 */
export function transformMapCallback(
  mapCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression {
  const { checker } = context;

  // Collect captured variables from the callback
  const collector = new CaptureCollector(checker);
  const { captureTree } = collector.analyze(callback);

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
