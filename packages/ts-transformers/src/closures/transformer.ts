import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";
import {
  createDataFlowAnalyzer,
  isEventHandlerJsxAttribute,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import {
  buildHierarchicalParamsValue,
  groupCapturesByRoot,
} from "../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../utils/capture-tree.ts";
import {
  getUniqueIdentifier,
  isSafeIdentifierText,
  maybeReuseIdentifier,
} from "../utils/identifiers.ts";

export class ClosureTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    return transformClosures(context);
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
 * Check if a declaration is within a callback's scope using node identity.
 */
function isDeclaredWithinCallback(
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
    !isDeclaredWithinCallback(decl, func)
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
    isDeclaredWithinCallback(decl, func)
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
      const captured = shouldCapturePropertyAccess(node, func, checker);
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

/**
 * Extract the root identifier name from an expression.
 * For property access like state.discount, returns "state".
 */
type CaptureTreeMap = Map<string, CaptureTreeNode>;

function createSafePropertyName(
  name: string,
  factory: ts.NodeFactory,
): ts.PropertyName {
  return isSafeIdentifierText(name)
    ? factory.createIdentifier(name)
    : factory.createStringLiteral(name);
}

function createParamsObjectLiteral(
  captureTree: Map<string, CaptureTreeNode>,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const assignments: ts.PropertyAssignment[] = [];
  for (const [rootName, rootNode] of captureTree) {
    assignments.push(
      factory.createPropertyAssignment(
        createSafePropertyName(rootName, factory),
        buildHierarchicalParamsValue(rootNode, rootName, factory),
      ),
    );
  }

  return factory.createObjectLiteralExpression(
    assignments,
    assignments.length > 0,
  );
}

function createParamsBindingPattern(
  captureTree: Map<string, CaptureTreeNode>,
  factory: ts.NodeFactory,
  createBindingIdentifier: (name: string) => ts.Identifier,
): ts.ObjectBindingPattern {
  const bindings: ts.BindingElement[] = [];
  for (const [rootName] of captureTree) {
    const propertyName = isSafeIdentifierText(rootName)
      ? undefined
      : createSafePropertyName(rootName, factory);
    bindings.push(
      factory.createBindingElement(
        undefined,
        propertyName,
        createBindingIdentifier(rootName),
        undefined,
      ),
    );
  }

  return factory.createObjectBindingPattern(bindings);
}

function normalizeBindingName(
  name: ts.BindingName,
  factory: ts.NodeFactory,
  used: Set<string>,
): ts.BindingName {
  if (ts.isIdentifier(name)) {
    return maybeReuseIdentifier(name, used);
  }

  if (ts.isObjectBindingPattern(name)) {
    const elements = name.elements.map((element) =>
      factory.createBindingElement(
        element.dotDotDotToken,
        element.propertyName,
        normalizeBindingName(element.name, factory, used),
        element.initializer as ts.Expression | undefined,
      )
    );
    return factory.createObjectBindingPattern(elements);
  }

  if (ts.isArrayBindingPattern(name)) {
    const elements = name.elements.map((element) => {
      if (ts.isOmittedExpression(element)) {
        return element;
      }
      if (ts.isBindingElement(element)) {
        return factory.createBindingElement(
          element.dotDotDotToken,
          element.propertyName,
          normalizeBindingName(element.name, factory, used),
          element.initializer as ts.Expression | undefined,
        );
      }
      return element;
    });
    return factory.createArrayBindingPattern(elements);
  }

  return name;
}

function typeNodeForExpression(
  expr: ts.Expression,
  context: TransformationContext,
): ts.TypeNode {
  const { factory, checker } = context;
  const exprType = checker.getTypeAtLocation(expr);
  const node = checker.typeToTypeNode(
    exprType,
    context.sourceFile,
    ts.NodeBuilderFlags.NoTruncation |
      ts.NodeBuilderFlags.UseStructuralFallback,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  const typeRegistry = context.options.typeRegistry;
  if (typeRegistry) {
    typeRegistry.set(node, exprType);
  }

  return node;
}

function buildCaptureTypeProperties(
  node: CaptureTreeNode,
  context: TransformationContext,
): ts.TypeElement[] {
  const { factory } = context;
  const properties: ts.TypeElement[] = [];

  for (const [propName, childNode] of node.properties) {
    let typeNode: ts.TypeNode;
    if (childNode.properties.size > 0 && !childNode.expression) {
      const nested = buildCaptureTypeProperties(childNode, context);
      typeNode = factory.createTypeLiteralNode(nested);
    } else if (childNode.expression) {
      typeNode = typeNodeForExpression(childNode.expression, context);
    } else {
      typeNode = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }

    properties.push(
      factory.createPropertySignature(
        undefined,
        createSafePropertyName(propName, factory),
        undefined,
        typeNode,
      ),
    );
  }

  return properties;
}

function buildParamsTypeElements(
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.TypeElement[] {
  const { factory } = context;
  const properties: ts.TypeElement[] = [];

  for (const [rootName, rootNode] of captureTree) {
    let typeNode: ts.TypeNode;
    if (rootNode.properties.size > 0 && !rootNode.expression) {
      const nested = buildCaptureTypeProperties(rootNode, context);
      typeNode = factory.createTypeLiteralNode(nested);
    } else if (rootNode.expression) {
      typeNode = typeNodeForExpression(rootNode.expression, context);
    } else {
      typeNode = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }

    properties.push(
      factory.createPropertySignature(
        undefined,
        createSafePropertyName(rootName, factory),
        undefined,
        typeNode,
      ),
    );
  }

  return properties;
}

function determineElementType(
  mapCall: ts.CallExpression,
  elemParam: ts.ParameterDeclaration | undefined,
  context: TransformationContext,
): { typeNode: ts.TypeNode; type?: ts.Type } {
  const { checker } = context;
  const typeRegistry = context.options.typeRegistry;

  if (elemParam?.type) {
    const annotationType = checker.getTypeFromTypeNode(elemParam.type);
    if (!(annotationType.flags & ts.TypeFlags.Any)) {
      const result = { typeNode: elemParam.type, type: annotationType };
      if (typeRegistry && annotationType) {
        typeRegistry.set(elemParam.type, annotationType);
      }
      return result;
    }
  }

  const inferred = inferElementType(mapCall, context);
  if (typeRegistry && inferred.type) {
    typeRegistry.set(inferred.typeNode, inferred.type);
  }
  return inferred;
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
  const paramsProperties = buildParamsTypeElements(
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
 */
function inferElementType(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): { typeNode: ts.TypeNode; type?: ts.Type } {
  const { factory, checker } = context;

  if (!ts.isPropertyAccessExpression(mapCall.expression)) {
    return {
      typeNode: factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    };
  }

  const arrayExpr = mapCall.expression.expression;
  const arrayType = checker.getTypeAtLocation(arrayExpr);

  // Handle OpaqueRef<T[]> which is an intersection type
  let actualArrayType = arrayType;
  if (arrayType.flags & ts.TypeFlags.Intersection) {
    const intersectionType = arrayType as ts.IntersectionType;
    // Look for the Reference type member (e.g., OpaqueRefMethods<T[]>)
    for (const type of intersectionType.types) {
      if (type.flags & ts.TypeFlags.Object) {
        const objType = type as ts.ObjectType;
        if (objType.objectFlags & ts.ObjectFlags.Reference) {
          actualArrayType = type;
          break;
        }
      }
    }
  }

  // Handle Opaque<T[]> which is a union type (T[] | OpaqueRef<T[]>)
  if (arrayType.flags & ts.TypeFlags.Union) {
    const unionType = arrayType as ts.UnionType;
    // Look for the OpaqueRef<T[]> member (intersection type)
    for (const member of unionType.types) {
      if (
        member.flags & ts.TypeFlags.Intersection ||
        isOpaqueRefType(member, checker)
      ) {
        actualArrayType = member;
        break;
      }
    }
  }

  // Get type arguments from the reference type
  let typeArgs: readonly ts.Type[] | undefined;

  // First check if actualArrayType is an intersection (OpaqueRef case)
  if (actualArrayType.flags & ts.TypeFlags.Intersection) {
    const intersectionType = actualArrayType as ts.IntersectionType;
    // Look for the Reference type member within the intersection
    for (const member of intersectionType.types) {
      if (member.flags & ts.TypeFlags.Object) {
        const objType = member as ts.ObjectType;
        if (objType.objectFlags & ts.ObjectFlags.Reference) {
          typeArgs = checker.getTypeArguments(objType as ts.TypeReference);
          break;
        }
      }
    }
  } else if (actualArrayType.flags & ts.TypeFlags.Object) {
    // Plain object/reference type case
    const objectType = actualArrayType as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      typeArgs = checker.getTypeArguments(objectType as ts.TypeReference);
    }
  }

  if (typeArgs && typeArgs.length > 0) {
    const innerType = typeArgs[0];
    if (innerType) {
      // innerType is either T[] or T depending on the structure
      let elementType: ts.Type;
      if (checker.isArrayType(innerType)) {
        // It's T[], extract T
        const extracted = checker.getIndexTypeOfType(
          innerType,
          ts.IndexKind.Number,
        );
        if (extracted) {
          elementType = extracted;
        } else {
          return {
            typeNode: factory.createKeywordTypeNode(
              ts.SyntaxKind.UnknownKeyword,
            ),
          };
        }
      } else {
        // It's already T
        elementType = innerType;
      }

      // Convert Type to TypeNode
      const typeNode = checker.typeToTypeNode(
        elementType,
        context.sourceFile,
        ts.NodeBuilderFlags.NoTruncation |
          ts.NodeBuilderFlags.UseStructuralFallback,
      ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

      return { typeNode, type: elementType };
    }
  }

  // Fallback for plain Array<T>
  if (checker.isArrayType(arrayType)) {
    const elementType = checker.getIndexTypeOfType(
      arrayType,
      ts.IndexKind.Number,
    );
    if (elementType) {
      const typeNode = checker.typeToTypeNode(
        elementType,
        context.sourceFile,
        ts.NodeBuilderFlags.NoTruncation |
          ts.NodeBuilderFlags.UseStructuralFallback,
      ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

      return { typeNode, type: elementType };
    }
  }

  return {
    typeNode: factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
  };
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
  const handlerExpr = context.ctHelpers.getHelperExpr("handler");
  const handlerCall = factory.createCallExpression(
    handlerExpr,
    undefined,
    [handlerCallback],
  );

  const paramsObject = createParamsObjectLiteral(captureTree, factory);

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

  const normaliseParameter = (
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
    ? normaliseParameter(
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

  const hasCaptures = captureTree.size > 0;
  const paramsBindingPattern = createParamsBindingPattern(
    captureTree,
    factory,
    createBindingIdentifier,
  );

  let paramsBindingName: ts.BindingName;
  if (hasCaptures) {
    paramsBindingName = paramsBindingPattern;
  } else if (stateParam) {
    paramsBindingName = normalizeBindingName(
      stateParam.name,
      factory,
      usedBindingNames,
    );
  } else {
    paramsBindingName = factory.createIdentifier(
      getUniqueIdentifier("__ct_handler_params", usedBindingNames, {
        fallback: "__ct_handler_params",
      }),
    );
  }

  const paramsParameter = stateParam
    ? normaliseParameter(stateParam, paramsBindingName)
    : factory.createParameterDeclaration(
      undefined,
      undefined,
      paramsBindingName,
      undefined,
      undefined,
      undefined,
    );

  const additionalParameters = extraParams.map((param) =>
    normaliseParameter(
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
): ts.CallExpression {
  const { factory } = context;

  const bindingElements: ts.BindingElement[] = [];
  const usedBindingNames = new Set<string>();

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

  const elementBindingName = elemParam
    ? normalizeBindingName(elemParam.name, factory, usedBindingNames)
    : createBindingIdentifier(
      captureTree.has("element") ? "__ct_element" : "element",
    );
  bindingElements.push(
    factory.createBindingElement(
      undefined,
      factory.createIdentifier("element"),
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

  const paramsPattern = createParamsBindingPattern(
    captureTree,
    factory,
    createBindingIdentifier,
  );

  bindingElements.push(
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
    factory.createObjectBindingPattern(bindingElements),
    undefined,
    undefined,
    undefined,
  );

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

  const paramsObject = createParamsObjectLiteral(captureTree, factory);

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
  );
}

function transformClosures(context: TransformationContext): ts.SourceFile {
  const { sourceFile } = context;

  const visitor = createClosureTransformVisitor(context);

  return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
}
