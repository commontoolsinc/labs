import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";
import { visitEachChildWithJsx } from "../ast/mod.ts";

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
  // Skip if node doesn't have a parent (can happen with synthetic nodes)
  if (!node.parent) {
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

  // Check if ALL declarations are within the callback
  const allDeclaredInside = declarations.every((decl) =>
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
 * Represents a hierarchical property path for a captured expression.
 * E.g., state.pricing.discount → { root: "state", path: ["pricing", "discount"] }
 */
interface CapturePathInfo {
  readonly root: string;
  readonly path: readonly string[];
  readonly expression: ts.Expression;
}

/**
 * Parse a captured expression into root identifier + property path.
 * Examples:
 *   state.discount → { root: "state", path: ["discount"] }
 *   state.pricing.discount → { root: "state", path: ["pricing", "discount"] }
 *   discount → { root: "discount", path: [] }
 */
function parseCaptureExpression(expr: ts.Expression): CapturePathInfo | undefined {
  if (ts.isIdentifier(expr)) {
    // Simple identifier - no path
    return {
      root: expr.text,
      path: [],
      expression: expr,
    };
  }

  if (ts.isPropertyAccessExpression(expr)) {
    // Build path from right to left
    const path: string[] = [];
    let current: ts.Expression = expr;

    while (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      current = current.expression;
    }

    if (ts.isIdentifier(current)) {
      return {
        root: current.text,
        path,
        expression: expr,
      };
    }
  }

  return undefined;
}

/**
 * Node in a hierarchical capture tree.
 */
interface CaptureTreeNode {
  properties: Map<string, CaptureTreeNode>;
  expressions: ts.Expression[];
}

/**
 * Group captured expressions by root identifier into hierarchical structure.
 *
 * Example:
 *   Input: [state.discount, state.taxRate, config.url]
 *   Output: {
 *     "state": {
 *       properties: {
 *         "discount": { properties: {}, expressions: [state.discount] },
 *         "taxRate": { properties: {}, expressions: [state.taxRate] }
 *       },
 *       expressions: []
 *     },
 *     "config": {
 *       properties: {
 *         "url": { properties: {}, expressions: [config.url] }
 *       },
 *       expressions: []
 *     }
 *   }
 */
function groupCapturesByRoot(
  captureExpressions: Set<ts.Expression>,
): Map<string, CaptureTreeNode> {
  const rootMap = new Map<string, CaptureTreeNode>();

  for (const expr of captureExpressions) {
    const pathInfo = parseCaptureExpression(expr);
    if (!pathInfo) continue;

    const { root, path } = pathInfo;

    // Get or create root node
    if (!rootMap.has(root)) {
      rootMap.set(root, { properties: new Map(), expressions: [] });
    }
    const rootNode = rootMap.get(root)!;

    if (path.length === 0) {
      // Simple identifier - store at root level
      rootNode.expressions.push(expr);
    } else {
      // Property access - build nested structure
      let currentNode = rootNode;
      for (const prop of path) {
        if (!currentNode.properties.has(prop)) {
          currentNode.properties.set(prop, { properties: new Map(), expressions: [] });
        }
        currentNode = currentNode.properties.get(prop)!;
      }
      // Store expression at leaf node
      currentNode.expressions.push(expr);
    }
  }

  return rootMap;
}

/**
 * Determine the element type for a map callback parameter.
 * Prefers explicit type annotation, falls back to inference from array type.
 */
function determineElementType(
  mapCall: ts.CallExpression,
  elemParam: ts.ParameterDeclaration | undefined,
  context: TransformationContext,
): { typeNode: ts.TypeNode; type?: ts.Type } {
  const { checker } = context;
  const typeRegistry = context.options.typeRegistry;

  // Check if we have an explicit type annotation that's not 'any'
  if (elemParam?.type) {
    const annotationType = checker.getTypeFromTypeNode(elemParam.type);
    if (!(annotationType.flags & ts.TypeFlags.Any)) {
      // Use the explicit annotation
      const result = { typeNode: elemParam.type, type: annotationType };
      // Register with typeRegistry
      if (typeRegistry && annotationType) {
        typeRegistry.set(elemParam.type, annotationType);
      }
      return result;
    }
  }

  // No annotation or annotation is 'any', infer from array
  const inferred = inferElementType(mapCall, context);
  // Register with typeRegistry
  if (typeRegistry && inferred.type) {
    typeRegistry.set(inferred.typeNode, inferred.type);
  }
  return inferred;
}

/**
 * Build type properties for a capture tree node recursively.
 * Creates nested object types for hierarchical captures.
 */
function buildCaptureTypeProperties(
  node: CaptureTreeNode,
  context: TransformationContext,
): ts.TypeElement[] {
  const { factory, checker } = context;
  const typeRegistry = context.options.typeRegistry;
  const properties: ts.TypeElement[] = [];

  // Add properties for nested captures
  for (const [propName, childNode] of node.properties) {
    if (childNode.properties.size > 0 || childNode.expressions.length > 1) {
      // This property has nested structure - create nested object type
      const nestedProperties = buildCaptureTypeProperties(childNode, context);
      const nestedTypeNode = factory.createTypeLiteralNode(nestedProperties);

      properties.push(
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier(propName),
          undefined,
          nestedTypeNode,
        ),
      );
    } else if (childNode.expressions.length === 1) {
      // Leaf property - get type from expression
      const expr = childNode.expressions[0]!;
      const exprType = checker.getTypeAtLocation(expr);
      const typeNode = checker.typeToTypeNode(
        exprType,
        context.sourceFile,
        ts.NodeBuilderFlags.NoTruncation |
          ts.NodeBuilderFlags.UseStructuralFallback,
      ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

      if (typeRegistry) {
        typeRegistry.set(typeNode, exprType);
      }

      properties.push(
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier(propName),
          undefined,
          typeNode,
        ),
      );
    }
  }

  // Add properties for expressions at this level (simple identifiers)
  for (const expr of node.expressions) {
    if (ts.isIdentifier(expr)) {
      const exprType = checker.getTypeAtLocation(expr);
      const typeNode = checker.typeToTypeNode(
        exprType,
        context.sourceFile,
        ts.NodeBuilderFlags.NoTruncation |
          ts.NodeBuilderFlags.UseStructuralFallback,
      ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

      if (typeRegistry) {
        typeRegistry.set(typeNode, exprType);
      }

      properties.push(
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier(expr.text),
          undefined,
          typeNode,
        ),
      );
    }
  }

  return properties;
}

/**
 * Build hierarchical params properties from capture tree.
 */
function buildHierarchicalParamsProperties(
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.TypeElement[] {
  const properties: ts.TypeElement[] = [];
  const { factory } = context;

  for (const [rootName, rootNode] of captureTree) {
    if (rootNode.properties.size > 0) {
      // Root has nested properties - create nested object type
      const nestedProperties = buildCaptureTypeProperties(rootNode, context);
      const nestedTypeNode = factory.createTypeLiteralNode(nestedProperties);

      properties.push(
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier(rootName),
          undefined,
          nestedTypeNode,
        ),
      );
    } else if (rootNode.expressions.length > 0) {
      // Simple identifier at root level
      const expr = rootNode.expressions[0]!;
      if (ts.isIdentifier(expr)) {
        const exprType = context.checker.getTypeAtLocation(expr);
        const typeNode = context.checker.typeToTypeNode(
          exprType,
          context.sourceFile,
          ts.NodeBuilderFlags.NoTruncation |
            ts.NodeBuilderFlags.UseStructuralFallback,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        if (context.options.typeRegistry) {
          context.options.typeRegistry.set(typeNode, exprType);
        }

        properties.push(
          factory.createPropertySignature(
            undefined,
            factory.createIdentifier(rootName),
            undefined,
            typeNode,
          ),
        );
      }
    }
  }

  return properties;
}

/**
 * Get the original parameter name from a parameter declaration.
 * Handles both simple identifiers and destructured patterns.
 */
function getOriginalParamName(
  param: ts.ParameterDeclaration | undefined,
  fallback: string,
): string {
  if (!param) return fallback;
  if (ts.isIdentifier(param.name)) {
    return param.name.text;
  }
  // For destructured params, use fallback
  return fallback;
}

/**
 * Build a TypeNode for the callback parameter and register property TypeNodes in typeRegistry.
 * Now returns a TypeLiteral with original parameter names: { item: T, index?: number, state: {...}, ... }
 */
function buildCallbackParamTypeNode(
  mapCall: ts.CallExpression,
  elemParam: ts.ParameterDeclaration | undefined,
  indexParam: ts.ParameterDeclaration | undefined,
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

  // 2. Get original parameter name (or fallback to "element")
  const elemParamName = getOriginalParamName(elemParam, "element");

  // 3. Build callback parameter properties
  const callbackParamProperties: ts.TypeElement[] = [
    factory.createPropertySignature(
      undefined,
      factory.createIdentifier(elemParamName),
      undefined,
      elemTypeNode,
    ),
  ];

  // 4. Add optional index property if present
  if (indexParam) {
    const indexParamName = getOriginalParamName(indexParam, "index");
    callbackParamProperties.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(indexParamName),
        factory.createToken(ts.SyntaxKind.QuestionToken),
        factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      ),
    );
  }

  // 5. Build hierarchical params properties from capture tree
  const hierarchicalParams = buildHierarchicalParamsProperties(
    captureTree,
    context,
  );

  // 6. Add all captured root properties directly to callback param
  callbackParamProperties.push(...hierarchicalParams);

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
 * Recursively compare expressions for structural equality.
 */
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

/**
 * Create a visitor function that transforms OpaqueRef map calls.
 * This visitor can be reused for both top-level and nested transformations.
 */
function createMapTransformVisitor(
  context: TransformationContext,
): ts.Visitor {
  const { checker } = context;

  const visit: ts.Visitor = (node) => {
    // Check for OpaqueRef<T[]> or Cell<T[]> map calls with callbacks
    if (ts.isCallExpression(node) && isOpaqueRefArrayMapCall(node, checker)) {
      const callback = node.arguments[0];

      // Check if the callback is an arrow function or function expression
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        return transformMapCallback(node, callback, context, visit);
      }
    }

    // Continue visiting children (handles JSX correctly)
    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return visit;
}

/**
 * Transform references to original element parameter if it was renamed.
 * With hierarchical params, we keep the original name, so this is rarely needed.
 * Only used when the parameter name itself needs normalization (e.g., collision resolution).
 */
function transformElementReferences(
  body: ts.ConciseBody,
  elemParam: ts.ParameterDeclaration | undefined,
  targetName: string,
  factory: ts.NodeFactory,
): ts.ConciseBody {
  const elemName = elemParam?.name;

  // Only rename if we have an identifier parameter that differs from target
  if (
    elemName &&
    ts.isIdentifier(elemName) &&
    elemName.text !== targetName
  ) {
    const visitor: ts.Visitor = (node) => {
      if (ts.isIdentifier(node) && node.text === elemName.text) {
        return factory.createIdentifier(targetName);
      }
      return visitEachChildWithJsx(node, visitor, undefined);
    };
    return ts.visitNode(body, visitor) as ts.ConciseBody;
  }

  return body;
}

/**
 * Transform destructured property references to use paramName.prop.
 * E.g., ({ price }) => price * 2 becomes (item) => item.price * 2
 */
function transformDestructuredProperties(
  body: ts.ConciseBody,
  elemParam: ts.ParameterDeclaration | undefined,
  paramName: string,
  factory: ts.NodeFactory,
): ts.ConciseBody {
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

  // If param was destructured, replace destructured property references with paramName.prop
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
            factory.createIdentifier(paramName),
            factory.createIdentifier(node.text),
          );
        }
      }
      return visitEachChildWithJsx(node, visitor, undefined);
    };
    return ts.visitNode(body, visitor) as ts.ConciseBody;
  }

  return body;
}

// Note: replaceCaptures() has been removed!
// With hierarchical params, captures keep their original names/structure,
// so no body rewriting is needed for captured expressions.

/**
 * Build hierarchical params object from capture tree recursively.
 */
function buildHierarchicalParamsObject(
  node: CaptureTreeNode,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const properties: ts.PropertyAssignment[] = [];

  // Add properties for nested captures
  for (const [propName, childNode] of node.properties) {
    if (childNode.properties.size > 0) {
      // Nested structure - recurse
      const nestedObject = buildHierarchicalParamsObject(childNode, factory);
      properties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          nestedObject,
        ),
      );
    } else if (childNode.expressions.length > 0) {
      // Leaf property - use the expression
      const expr = childNode.expressions[0]!;
      properties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          expr,
        ),
      );
    }
  }

  return factory.createObjectLiteralExpression(properties, false);
}

/**
 * Detect and resolve parameter name collisions with captured roots.
 * Returns a map of original root name → adjusted name.
 */
function resolveNameCollisions(
  elemParamName: string,
  indexParamName: string | undefined,
  captureTree: Map<string, CaptureTreeNode>,
): Map<string, string> {
  const collisionMap = new Map<string, string>();
  const paramNames = new Set([elemParamName]);
  if (indexParamName) paramNames.add(indexParamName);

  for (const rootName of captureTree.keys()) {
    if (paramNames.has(rootName)) {
      // Collision detected - add suffix
      let suffix = 1;
      let newName = `${rootName}_${suffix}`;
      while (paramNames.has(newName) || captureTree.has(newName)) {
        suffix++;
        newName = `${rootName}_${suffix}`;
      }
      collisionMap.set(rootName, newName);
      paramNames.add(newName);
    } else {
      collisionMap.set(rootName, rootName);
    }
  }

  return collisionMap;
}

/**
 * Create the final recipe call with hierarchical params object.
 * Uses original parameter names and nested structure for captures.
 */
function createRecipeCallWithParams(
  mapCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  elemParam: ts.ParameterDeclaration | undefined,
  indexParam: ts.ParameterDeclaration | undefined,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.CallExpression {
  const { factory } = context;

  // Get original parameter names
  const elemParamName = getOriginalParamName(elemParam, "element");
  const indexParamName = indexParam
    ? getOriginalParamName(indexParam, "index")
    : undefined;

  // Resolve any name collisions
  const nameMap = resolveNameCollisions(
    elemParamName,
    indexParamName,
    captureTree,
  );

  // Create the destructured parameter with original names
  const properties: ts.BindingElement[] = [
    factory.createBindingElement(
      undefined,
      undefined,
      factory.createIdentifier(elemParamName),
      undefined,
    ),
  ];

  if (indexParam && indexParamName) {
    properties.push(
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier(indexParamName),
        undefined,
      ),
    );
  }

  // Add captured roots as direct parameters (with collision-resolved names)
  for (const [originalRoot, adjustedRoot] of nameMap) {
    properties.push(
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier(adjustedRoot),
        undefined,
      ),
    );
  }

  const destructuredParam = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(properties),
    undefined,
    undefined,
    undefined,
  );

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

  // Build a TypeNode for the callback parameter to pass as a type argument to recipe<T>()
  const callbackParamTypeNode = buildCallbackParamTypeNode(
    mapCall,
    elemParam,
    indexParam,
    captureTree,
    context,
  );

  // Wrap in recipe<T>() using type argument
  const recipeExpr = context.ctHelpers.getHelperExpr("recipe");
  const recipeCall = factory.createCallExpression(
    recipeExpr,
    [callbackParamTypeNode], // Type argument
    [newCallback],
  );

  // Create the hierarchical params object
  const paramProperties: ts.PropertyAssignment[] = [];
  for (const [originalRoot, adjustedRoot] of nameMap) {
    const rootNode = captureTree.get(originalRoot);
    if (!rootNode) continue;

    if (rootNode.properties.size > 0) {
      // Nested structure
      const nestedObject = buildHierarchicalParamsObject(rootNode, factory);
      paramProperties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(adjustedRoot),
          nestedObject,
        ),
      );
    } else if (rootNode.expressions.length > 0) {
      // Simple identifier
      const expr = rootNode.expressions[0]!;
      paramProperties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(adjustedRoot),
          expr,
        ),
      );
    }
  }
  const paramsObject = factory.createObjectLiteralExpression(paramProperties);

  // Create mapWithPattern property access
  const mapWithPatternAccess = ts.isPropertyAccessExpression(mapCall.expression)
    ? factory.createPropertyAccessExpression(
      mapCall.expression.expression, // state.items
      factory.createIdentifier("mapWithPattern"),
    )
    : factory.createIdentifier("mapWithPattern"); // Fallback (shouldn't happen)

  // Return the transformed mapWithPattern call
  return factory.createCallExpression(
    mapWithPatternAccess,
    mapCall.typeArguments,
    [recipeCall, paramsObject],
  );
}

/**
 * Transform a map callback for OpaqueRef arrays using hierarchical params.
 * Always transforms to use recipe + mapWithPattern, even with no captures,
 * to ensure callback parameters become opaque.
 */
function transformMapCallback(
  mapCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression {
  const { factory, checker } = context;

  // Collect captured variables from the callback
  const captureExpressions = collectCaptures(callback, checker);

  // Group captures by root identifier into hierarchical tree
  const captureTree = groupCapturesByRoot(captureExpressions);

  // Get callback parameters
  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const indexParam = originalParams[1]; // May be undefined

  // Get original parameter name (for destructured property transformation)
  const elemParamName = getOriginalParamName(elemParam, "element");

  // IMPORTANT: First, recursively transform any nested map callbacks BEFORE we change
  // parameter names. This ensures nested callbacks can properly detect captures from
  // parent callback scope. Reuse the same visitor for consistency.
  let transformedBody = ts.visitNode(callback.body, visitor) as ts.ConciseBody;

  // Transform the callback body in stages:
  // Note: With hierarchical params, we DON'T need to replace captures!
  // They already have the correct names/structure.

  // 1. Transform element parameter reference if needed
  // (Usually not needed since we use original name)
  transformedBody = transformElementReferences(
    transformedBody,
    elemParam,
    elemParamName,
    factory,
  );

  // 2. Transform destructured properties to use paramName.prop
  // This is the ONLY case where body transformation is still needed
  transformedBody = transformDestructuredProperties(
    transformedBody,
    elemParam,
    elemParamName,
    factory,
  );

  // 3. NO capture replacement needed! That's the magic of hierarchical params.

  // Create the final recipe call with hierarchical params
  return createRecipeCallWithParams(
    mapCall,
    callback,
    transformedBody,
    elemParam,
    indexParam,
    captureTree,
    context,
  );
}

function transformClosures(context: TransformationContext): ts.SourceFile {
  const { sourceFile } = context;

  // Create a unified visitor that handles both top-level and nested map transformations
  const visitor = createMapTransformVisitor(context);

  return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
}
