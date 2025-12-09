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
 * Get the root identifier from an expression.
 * For example: `a.alternatives.length` -> `a`
 *              `foo` -> `foo`
 *              `arr[0].bar` -> `arr`
 */
function getRootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let current = expr;
  while (true) {
    if (ts.isIdentifier(current)) {
      return current;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
}

/**
 * Get parameter names from a callback function.
 */
function getCallbackParameterNames(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): Set<string> {
  const names = new Set<string>();
  for (const param of callback.parameters) {
    collectBindingNames(param.name, names);
  }
  return names;
}

/**
 * Collect all identifier names from a binding pattern.
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
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
}

/**
 * Check if a callback is from a mapWithPattern call.
 */
function isMapWithPatternCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): boolean {
  if (!callback.parent || !ts.isCallExpression(callback.parent)) {
    return false;
  }
  const callKind = detectCallKind(callback.parent, checker);
  return callKind?.kind === "array-map";
}

/**
 * Check if the map target's root identifier comes from a mapWithPattern
 * element parameter somewhere in the ancestor chain.
 *
 * When we have nested structures like:
 *   assumptions.mapWithPattern(({ element: a }) => {
 *     a.alternatives.map(...)  // This should be transformed
 *   })
 *
 * The `a` variable is the element from mapWithPattern, and its properties
 * (like `a.alternatives`) are still opaque refs that should be transformed.
 */
function isRootFromMapWithPatternElement(
  mapTarget: ts.Expression,
  mapCall: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const rootId = getRootIdentifier(mapTarget);
  if (!rootId) return false;

  // Walk up the AST looking for mapWithPattern callbacks
  let node: ts.Node = mapCall;
  while (node.parent) {
    if (
      ts.isArrowFunction(node.parent) || ts.isFunctionExpression(node.parent)
    ) {
      const callback = node.parent;
      if (isMapWithPatternCallback(callback, checker)) {
        // Check if the root identifier matches the element parameter
        // mapWithPattern callbacks have signature: ({ element, params }) => ...
        // or with destructuring: ({ element: a, params }) => ...
        const paramNames = getCallbackParameterNames(callback);
        if (paramNames.has(rootId.text)) {
          // The root identifier is from a mapWithPattern element parameter
          return true;
        }
      }
    }
    node = node.parent;
  }

  return false;
}

/**
 * Check if map call is inside a derive/computed callback with a non-Cell OpaqueRef
 * that is actually captured and unwrapped by the derive.
 * Returns true if we should skip transformation due to OpaqueRef unwrapping.
 *
 * The key insight is that derive only unwraps OpaqueRefs that are passed as
 * captures. If the map target's root comes from a mapWithPattern element
 * parameter, it's NOT unwrapped by the derive and should still be transformed.
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
              // Special case: If the map target's root comes from a
              // mapWithPattern element parameter, it's still opaque and
              // should be transformed, even though we're inside a derive.
              if (
                isRootFromMapWithPatternElement(mapTarget, mapCall, checker)
              ) {
                // Continue looking at outer callbacks - there might be
                // other derives that would prevent transformation.
                node = node.parent;
                continue;
              }
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
  const insideDeriveWithOpaque = isInsideDeriveWithOpaqueRef(mapCall, context);
  if (insideDeriveWithOpaque) {
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
