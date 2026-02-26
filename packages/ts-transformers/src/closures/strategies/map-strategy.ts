import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  classifyReactiveContext,
  detectCallKind,
  getTypeAtLocationWithFallback,
  isDeriveCall,
  isFunctionLikeExpression,
  isReactiveArrayMapCall,
  registerSyntheticCallType,
} from "../../ast/mod.ts";
import {
  classifyReactiveReceiverKind,
  shouldRewriteCollectionMethod,
} from "../../policy/mod.ts";
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
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";

export class MapStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    _context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map";
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
 * Checks if this is an OpaqueRef<T[]> or Cell<T[]> map call.
 * Only transforms map calls on reactive arrays (OpaqueRef/Cell), not plain arrays.
 *
 * @deprecated Use isReactiveArrayMapCall from ast/mod.ts instead.
 * This is kept for backwards compatibility but delegates to the shared implementation.
 */
export function isOpaqueRefArrayMapCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  logger?: (message: string) => void,
): boolean {
  return isReactiveArrayMapCall(node, checker, typeRegistry, logger);
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
 * Check if a map call should be transformed to mapWithPattern.
 *
 * Type-based approach with context awareness (CT-1186 fix):
 * 1. derive() calls always return OpaqueRef at runtime -> TRANSFORM
 * 2. Inside safe wrappers (computed/derive/etc), OpaqueRef gets auto-unwrapped
 *    to a plain array, so we should NOT transform OpaqueRef .map() calls there.
 *    However, Cell and Stream do NOT get auto-unwrapped, so we still transform those.
 * 3. Outside safe wrappers, transform all cell-like types (OpaqueRef, Cell, Stream).
 */
function shouldTransformMap(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  if (!ts.isPropertyAccessExpression(mapCall.expression)) return false;

  const methodName = mapCall.expression.name.text;
  if (methodName !== "map") {
    return false;
  }

  if (context.options.useLegacyOpaqueRefSemantics) {
    return shouldTransformMapLegacy(mapCall, context);
  }

  const mapTarget = mapCall.expression.expression;
  const contextInfo = classifyReactiveContext(mapCall, context.checker, context);

  if (contextInfo.kind === "pattern" && isReactiveMapOrigin(mapTarget, context)) {
    return true;
  }

  // derive() returns an opaque value at runtime, but checker fallback may see the
  // unwrapped callback result type. Preserve policy by context.
  if (isDeriveCall(mapTarget)) {
    return contextInfo.kind === "pattern";
  }

  const targetType = getTypeAtLocationWithFallback(
    mapTarget,
    context.checker,
    context.options.typeRegistry,
    context.options.logger,
  );
  const receiverKind = classifyReactiveReceiverKind(targetType, context.checker);

  return shouldRewriteCollectionMethod(
    contextInfo.kind,
    methodName,
    receiverKind,
  );
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPartiallyEmittedExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken;
}

function isReactiveMapOrigin(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const current = unwrapExpression(expression);

  if (isDeriveCall(current)) {
    return true;
  }

  if (ts.isCallExpression(current)) {
    const callee = unwrapExpression(current.expression);
    if (ts.isIdentifier(callee)) {
      if (callee.text === "derive" || callee.text === "computed") {
        return true;
      }
    } else if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === "derive" || callee.name.text === "computed")
    ) {
      return true;
    }

    const kind = detectCallKind(current, context.checker);
    if (kind?.kind === "derive") {
      return true;
    }
    if (kind?.kind === "builder" && kind.builderName === "computed") {
      return true;
    }
  }

  const type = getTypeAtLocationWithFallback(
    current,
    context.checker,
    context.options.typeRegistry,
    context.options.logger,
  );
  if (classifyReactiveReceiverKind(type, context.checker) !== "plain") {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return isReactiveMapOrigin(current.expression, context, seenSymbols);
  }

  if (ts.isBinaryExpression(current) && isFallbackOperator(current.operatorToken.kind)) {
    return isReactiveMapOrigin(current.left, context, seenSymbols) ||
      isReactiveMapOrigin(current.right, context, seenSymbols);
  }

  if (!ts.isIdentifier(current)) {
    return false;
  }

  const symbol = context.checker.getSymbolAtLocation(current);
  if (!symbol || seenSymbols.has(symbol)) {
    return false;
  }
  seenSymbols.add(symbol);

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (isReactiveMapOrigin(declaration.initializer, context, seenSymbols)) {
        return true;
      }
    }
  }

  return false;
}

function shouldTransformMapLegacy(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  if (!ts.isPropertyAccessExpression(mapCall.expression)) return false;

  const mapTarget = mapCall.expression.expression;

  // Special case: derive() always returns OpaqueRef at runtime
  if (isDeriveCall(mapTarget)) {
    return true;
  }

  const targetType = getTypeAtLocationWithFallback(
    mapTarget,
    context.checker,
    context.options.typeRegistry,
    context.options.logger,
  );

  if (!targetType) return false;

  const receiverKind = classifyReactiveReceiverKind(targetType, context.checker);
  if (receiverKind === "plain") {
    return false;
  }

  const contextInfo = classifyReactiveContext(mapCall, context.checker, context);
  if (contextInfo.kind === "compute") {
    return receiverKind === "celllike_requires_rewrite";
  }

  return true;
}

/**
 * Create the final pattern call with params object.
 */
/**
 * Create the final pattern call with params object.
 */
function createPatternCallWithParams(
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

  // Initialize PatternBuilder
  const builder = new PatternBuilder(context);
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

  // Create pattern call
  const patternExpr = context.ctHelpers.getHelperExpr("pattern");
  const typeArgs = [callbackParamTypeNode];
  if (resultTypeNode) {
    typeArgs.push(resultTypeNode);
  }

  const patternCall = factory.createCallExpression(
    patternExpr,
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

  const args: ts.Expression[] = [patternCall, paramsObject];
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

  const mapWithPatternCall = factory.createCallExpression(
    mapWithPatternAccess,
    mapCall.typeArguments,
    args,
  );

  // Register the result type for the mapWithPattern call so schema injection
  // can find it when this call is used inside ifElse branches
  if (typeRegistry) {
    // The result type of mapWithPattern is the same as the original map call
    const mapResultType = context.checker.getTypeAtLocation(mapCall);
    registerSyntheticCallType(mapWithPatternCall, mapResultType, typeRegistry);
  }

  return mapWithPatternCall;
}

/**
 * Transform a map callback for OpaqueRef arrays.
 * Always transforms to use pattern + mapWithPattern, even with no captures,
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

  // Create the final pattern call with params
  return createPatternCallWithParams(
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
