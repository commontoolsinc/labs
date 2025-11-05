import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";
import {
  createDataFlowAnalyzer,
  getMethodCallTarget,
  isEventHandlerJsxAttribute,
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
  if (declarations.some((decl) => isFunctionDeclaration(decl))) {
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
    const isCallbackParam = func.parameters.some((param) => {
      if (ts.isIdentifier(param.name) && param.name.text === node.text) {
        return true;
      }
      // Also check destructured parameters
      if (ts.isObjectBindingPattern(param.name)) {
        return param.name.elements.some((element) =>
          ts.isBindingElement(element) &&
          ts.isIdentifier(element.name) &&
          element.name.text === node.text
        );
      }
      // Also check array binding patterns (e.g., ([item]) => ...)
      if (ts.isArrayBindingPattern(param.name)) {
        return param.name.elements.some((element) =>
          ts.isBindingElement(element) &&
          ts.isIdentifier(element.name) &&
          element.name.text === node.text
        );
      }
      return false;
    });

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
  const isFunction = declarations.some((decl) => isFunctionDeclaration(decl));
  if (isFunction) {
    return undefined;
  }

  // If we got here, at least one declaration is outside the callback
  // So it's a captured variable
  return node;
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
    // Don't visit inside nested functions - their scope is separate
    if (node !== func && ts.isFunctionLike(node)) {
      return;
    }

    // For property access like state.discount, capture the whole expression
    if (ts.isPropertyAccessExpression(node)) {
      // If this is a method call, try to capture the object instead of the method
      // Example: state.counter.set() -> capture state.counter, not state.counter.set
      const methodTarget = getMethodCallTarget(node);
      const captureNode = methodTarget || node;

      const captured = shouldCapturePropertyAccess(captureNode, func, checker);
      if (captured) {
        captures.add(captured);
        // Don't visit children of this property access
        return;
      }
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
  const paramsProperties = buildTypeElementsFromCaptureTree(captureTree, context);
  return factory.createTypeLiteralNode(paramsProperties);
}

/**
 * Check if a map call should be transformed to mapWithPattern.
 * Returns false if the map will end up inside a derive (where the array is unwrapped).
 *
 * This happens when the map is nested inside a larger expression with opaque refs,
 * e.g., `list.length > 0 && list.map(...)` becomes `derive(list, list => ...)`
 */
function shouldTransformMap(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  // Find the closest containing JSX expression
  let node: ts.Node = mapCall;
  let closestJsxExpression: ts.JsxExpression | undefined;

  while (node.parent) {
    if (ts.isJsxExpression(node.parent)) {
      closestJsxExpression = node.parent;
      break;
    }
    node = node.parent;
  }

  // If we didn't find a JSX expression, default to transforming
  // (this handles maps in regular statements like `const x = items.map(...)`)
  if (!closestJsxExpression || !closestJsxExpression.expression) {
    return true;
  }

  const analyze = createDataFlowAnalyzer(context.checker);

  //Case 1: Map is nested in a larger expression within the same JSX expression
  // Example: {list.length > 0 && list.map(...)}
  // Only check THIS expression for derive wrapping
  if (closestJsxExpression.expression !== mapCall) {
    const analysis = analyze(closestJsxExpression.expression);
    // Check if this will be wrapped in a derive (not just transformed in some other way)
    // Array-map calls have skip-call-rewrite hint, so they won't be wrapped in derive
    const willBeWrappedInDerive = analysis.requiresRewrite &&
      !(analysis.rewriteHint?.kind === "skip-call-rewrite" &&
        analysis.rewriteHint.reason === "array-map");
    return !willBeWrappedInDerive;
  }

  // Case 2: Map IS the direct content of the JSX expression
  // Example: <div>{list.map(...)}</div>
  // Check if an ANCESTOR JSX expression will wrap this in a derive
  node = closestJsxExpression.parent;
  while (node) {
    if (ts.isJsxExpression(node) && node.expression) {
      const analysis = analyze(node.expression);
      const willBeWrappedInDerive = analysis.requiresRewrite &&
        !(analysis.rewriteHint?.kind === "skip-call-rewrite" &&
          analysis.rewriteHint.reason === "array-map");
      if (willBeWrappedInDerive) {
        // An ancestor JSX expression will wrap this in a derive
        return false;
      }
    }
    node = node.parent;
  }

  // No ancestor will wrap in derive, transform normally
  return true;
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

    if (ts.isCallExpression(node) && isOpaqueRefArrayMapCall(node, checker)) {
      const callback = node.arguments[0];

      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        if (shouldTransformMap(node, context)) {
          return transformMapCallback(node, callback, context, visit);
        }
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

  const paramProperties: ts.PropertyAssignment[] = [];
  for (const [rootName, rootNode] of captureTree) {
    paramProperties.push(
      factory.createPropertyAssignment(
        createPropertyName(rootName, factory),
        buildHierarchicalParamsValue(rootNode, rootName, factory),
      ),
    );
  }

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

  const paramProperties: ts.PropertyAssignment[] = [];
  for (const [rootName, rootNode] of captureTree) {
    paramProperties.push(
      factory.createPropertyAssignment(
        createPropertyName(rootName, factory),
        buildHierarchicalParamsValue(rootNode, rootName, factory),
      ),
    );
  }

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

function transformClosures(context: TransformationContext): ts.SourceFile {
  const { sourceFile } = context;

  const visitor = createClosureTransformVisitor(context);

  return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
}
