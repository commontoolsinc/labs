import ts from "typescript";
import { type TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  classifyReactiveContext,
  detectCallKind,
  getTypeAtLocationWithFallback,
  isDeriveCall,
  isFunctionLikeExpression,
  isReactiveOriginCall,
  type ReactiveContextInfo,
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
import {
  analyzeElementBinding,
  rewriteCallbackBody,
} from "./array-method-utils.ts";
import type { ComputedAliasInfo } from "./array-method-utils.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import {
  cloneKeyExpression,
  getKnownComputedKeyExpression,
  isCommonToolsKeyIdentifier,
  isFallbackOperator,
} from "../../utils/reactive-keys.ts";
import { rewriteArrayMethodCallbackExpressionSites } from "../../transformers/expression-site-lowering.ts";

const METHOD_TO_WITH_PATTERN: Record<string, string> = {
  map: "mapWithPattern",
  filter: "filterWithPattern",
  flatMap: "flatMapWithPattern",
};

const WITH_PATTERN_METHOD_NAMES = new Set([
  "mapWithPattern",
  "filterWithPattern",
  "flatMapWithPattern",
]);

export class ArrayMethodStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    _context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      Object.hasOwn(METHOD_TO_WITH_PATTERN, node.expression.name.text);
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;

    const callback = node.arguments[0];
    if (callback && isFunctionLikeExpression(callback)) {
      if (shouldTransformArrayMethod(node, context)) {
        return transformArrayMethodCallback(node, callback, context, visitor);
      }
    }
    return undefined;
  }
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

function getEnclosingFunctionLike(
  node: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function isConsumedByTerminalChain(
  expression: ts.Expression,
): boolean {
  let current: ts.Expression = expression;

  while (true) {
    const parent = current.parent;
    if (!parent) {
      return false;
    }

    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      current = parent;
      continue;
    }

    if (
      ts.isPropertyAccessExpression(parent) && parent.expression === current
    ) {
      const memberName = parent.name.text;
      if (
        Object.hasOwn(METHOD_TO_WITH_PATTERN, memberName) ||
        WITH_PATTERN_METHOD_NAMES.has(memberName)
      ) {
        const callParent = parent.parent;
        if (
          callParent &&
          ts.isCallExpression(callParent) &&
          callParent.expression === parent
        ) {
          current = callParent;
          continue;
        }
      }
      return true;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      return true;
    }

    if (ts.isCallExpression(parent) && parent.expression === current) {
      return true;
    }

    return false;
  }
}

function createsReactiveCollectionInPlace(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const current = unwrapExpression(expression);

  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return createsReactiveCollectionInPlace(current.expression, context);
  }

  if (!ts.isCallExpression(current)) {
    return false;
  }

  const currentType = getTypeAtLocationWithFallback(
    current,
    context.checker,
    context.options.typeRegistry,
    context.options.logger,
  );
  if (
    classifyReactiveReceiverKind(current, currentType, context.checker) ===
      "celllike_requires_rewrite"
  ) {
    return true;
  }

  if (shouldTransformArrayMethod(current, context)) {
    return true;
  }

  return isReactiveOriginCall(current, context.checker);
}

function isLocalReactiveRewrapAlias(
  expression: ts.Expression,
  scope: ts.FunctionLikeDeclaration,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const current = unwrapExpression(expression);

  if (createsReactiveCollectionInPlace(current, context)) {
    return true;
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
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      continue;
    }

    if (getEnclosingFunctionLike(declaration) !== scope) {
      continue;
    }

    if (
      isLocalReactiveRewrapAlias(
        declaration.initializer,
        scope,
        context,
        seenSymbols,
      )
    ) {
      return true;
    }
  }

  return false;
}

function getNodeSnippet(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  maxLength = 160,
): string {
  try {
    const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  } catch {
    return ts.SyntaxKind[node.kind];
  }
}

type SyntheticComputeOwnedLookup = Pick<
  TransformationContext,
  "sourceFile" | "isSyntheticComputeOwnedNode"
>;

export function assertValidSyntheticComputeOwnedArrayMethodContext(
  methodCall: ts.CallExpression,
  contextInfo: ReactiveContextInfo,
  context: SyntheticComputeOwnedLookup,
): void {
  const receiver = ts.isPropertyAccessExpression(methodCall.expression)
    ? methodCall.expression.expression
    : undefined;
  const isSyntheticComputeOwned = context.isSyntheticComputeOwnedNode(
    methodCall,
  ) ||
    (receiver ? context.isSyntheticComputeOwnedNode(receiver) : false);

  if (!isSyntheticComputeOwned) {
    return;
  }

  if (contextInfo.kind === "compute") {
    return;
  }

  if (
    contextInfo.kind === "pattern" &&
    contextInfo.owner === "array-method"
  ) {
    return;
  }

  throw new Error(
    [
      "Internal Common Tools compiler error: synthetic compute-owned array method retained a non-compute context.",
      "This is a bug in the compiler, not in your code. Please report it to the maintainers.",
      `Method call: \`${getNodeSnippet(methodCall, context.sourceFile)}\``,
      `Reactive context: ${contextInfo.kind} (${contextInfo.owner})`,
    ].join("\n"),
  );
}

/**
 * Check if an array method call should be transformed to its WithPattern variant.
 *
 * Type-based approach with context awareness (CT-1186 fix):
 * 1. derive() calls always return OpaqueRef at runtime -> TRANSFORM
 * 2. Inside safe wrappers (computed/derive/etc), OpaqueRef gets auto-unwrapped
 *    to a plain array, so we should NOT transform OpaqueRef method calls there.
 *    However, Cell and Stream do NOT get auto-unwrapped, so we still transform those.
 * 3. Local aliases created by nested computed()/derive() calls inside the current
 *    compute callback become opaque again and should transform.
 * 4. Outside safe wrappers, transform all cell-like types (OpaqueRef, Cell, Stream).
 */
function shouldTransformArrayMethod(
  methodCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  if (!ts.isPropertyAccessExpression(methodCall.expression)) return false;

  const methodName = methodCall.expression.name.text;
  if (!Object.hasOwn(METHOD_TO_WITH_PATTERN, methodName)) {
    return false;
  }

  if (isConsumedByTerminalChain(methodCall)) {
    return false;
  }

  const mapTarget = methodCall.expression.expression;
  const contextInfo = classifyReactiveContext(
    methodCall,
    context.checker,
    context,
  );
  assertValidSyntheticComputeOwnedArrayMethodContext(
    methodCall,
    contextInfo,
    context,
  );

  const targetType = getTypeAtLocationWithFallback(
    mapTarget, // the receiver of the array method call
    context.checker,
    context.options.typeRegistry,
    context.options.logger,
  );
  const receiverKind = classifyReactiveReceiverKind(
    mapTarget,
    targetType,
    context.checker,
  );

  if (
    contextInfo.kind === "pattern" && isReactiveMapOrigin(mapTarget, context)
  ) {
    return true;
  }

  const enclosingFunction = getEnclosingFunctionLike(methodCall);
  if (
    contextInfo.kind === "compute" &&
    enclosingFunction &&
    isLocalReactiveRewrapAlias(mapTarget, enclosingFunction, context)
  ) {
    return true;
  }

  // derive() returns an opaque value at runtime, but checker fallback may see the
  // unwrapped callback result type. Preserve policy by context.
  if (isDeriveCall(mapTarget)) {
    return contextInfo.kind === "pattern";
  }

  return shouldRewriteCollectionMethod(
    contextInfo.kind,
    methodName,
    receiverKind,
  );
}

function isKnownComputedKey(
  expression: ts.Expression,
  context: TransformationContext,
): expression is ts.Identifier {
  return isCommonToolsKeyIdentifier(expression, context, "NAME") ||
    isCommonToolsKeyIdentifier(expression, context, "UI") ||
    isCommonToolsKeyIdentifier(expression, context, "SELF");
}

function lowerMapReceiverMemberAccess(
  expression: ts.Expression,
  context: TransformationContext,
): ts.Expression {
  const segments: ts.Expression[] = [];
  let current = unwrapExpression(expression);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(context.factory.createStringLiteral(current.name.text));
      current = unwrapExpression(current.expression);
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      const arg = current.argumentExpression;
      if (
        arg &&
        (ts.isStringLiteral(arg) ||
          ts.isNumericLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        segments.unshift(context.factory.createStringLiteral(arg.text));
        current = unwrapExpression(current.expression);
        continue;
      }
      if (arg && isKnownComputedKey(arg, context)) {
        segments.unshift(
          getKnownComputedKeyExpression(arg, context) ??
            cloneKeyExpression(arg, context.factory),
        );
        current = unwrapExpression(current.expression);
        continue;
      }
      return expression;
    }

    break;
  }

  if (!ts.isIdentifier(current) || segments.length === 0) {
    return expression;
  }

  return context.factory.createCallExpression(
    context.factory.createPropertyAccessExpression(
      context.factory.createIdentifier(current.text),
      context.factory.createIdentifier("key"),
    ),
    undefined,
    segments,
  );
}

function bindingContainsName(
  binding: ts.BindingName,
  name: string,
): boolean {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  for (const element of binding.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (bindingContainsName(element.name, name)) {
      return true;
    }
  }
  return false;
}

function isPatternBuilderCallback(
  node: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return false;
  }
  if (!parent.arguments.includes(node)) {
    return false;
  }

  const kind = detectCallKind(parent, context.checker);
  if (kind?.kind === "builder" && kind.builderName === "pattern") {
    return true;
  }

  const expression = unwrapExpression(parent.expression);
  if (ts.isIdentifier(expression)) {
    return expression.text === "pattern";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "pattern";
  }
  return false;
}

function isIdentifierBoundInPatternCallback(
  identifier: ts.Identifier,
  context: TransformationContext,
): boolean {
  let current: ts.Node | undefined = identifier.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (!isPatternBuilderCallback(current, context)) {
        current = current.parent;
        continue;
      }

      const firstParam = current.parameters[0];
      if (!firstParam) {
        return false;
      }
      return bindingContainsName(firstParam.name, identifier.text);
    }
    current = current.parent;
  }
  return false;
}

function isPatternOwnedParameterDeclaration(
  declaration: ts.ParameterDeclaration,
  context: TransformationContext,
): boolean {
  const owner = declaration.parent;
  if (
    !owner || (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner))
  ) {
    return false;
  }
  if (!isPatternBuilderCallback(owner, context)) {
    return false;
  }
  return owner.parameters[0] === declaration;
}

function isReactiveCollectionCallbackParameter(
  declaration: ts.ParameterDeclaration,
  context: TransformationContext,
): boolean {
  const owner = declaration.parent;
  if (
    !owner || (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner))
  ) {
    return false;
  }

  const call = owner.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(owner)) {
    return false;
  }

  if (!ts.isPropertyAccessExpression(call.expression)) {
    return false;
  }

  const methodName = call.expression.name.text;
  if (
    !Object.hasOwn(METHOD_TO_WITH_PATTERN, methodName) &&
    methodName !== "mapWithPattern" &&
    methodName !== "filterWithPattern" &&
    methodName !== "flatMapWithPattern"
  ) {
    return false;
  }

  return isReactiveMapOrigin(call.expression.expression, context);
}

function getOwningParameterDeclaration(
  declaration: ts.BindingElement,
): ts.ParameterDeclaration | undefined {
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (ts.isParameter(current)) {
      return current;
    }
    if (ts.isSourceFile(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
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

    if (isReactiveOriginCall(current, context.checker)) {
      return true;
    }

    // Syntactic chaining detection: .filter().map() — the intermediate result
    // of a reactive array method call is still reactive.
    if (
      ts.isPropertyAccessExpression(current.expression) &&
      Object.hasOwn(METHOD_TO_WITH_PATTERN, current.expression.name.text)
    ) {
      return isReactiveMapOrigin(
        current.expression.expression,
        context,
        seenSymbols,
      );
    }
  }

  const type = getTypeAtLocationWithFallback(
    current,
    context.checker,
    context.options.typeRegistry,
    context.options.logger,
  );
  if (
    classifyReactiveReceiverKind(current, type, context.checker) !== "plain"
  ) {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return isReactiveMapOrigin(current.expression, context, seenSymbols);
  }

  if (
    ts.isBinaryExpression(current) &&
    isFallbackOperator(current.operatorToken.kind)
  ) {
    return isReactiveMapOrigin(current.left, context, seenSymbols) ||
      isReactiveMapOrigin(current.right, context, seenSymbols);
  }

  if (!ts.isIdentifier(current)) {
    return false;
  }

  if (isIdentifierBoundInPatternCallback(current, context)) {
    return true;
  }

  const symbol = context.checker.getSymbolAtLocation(current);
  if (!symbol || seenSymbols.has(symbol)) {
    return false;
  }
  seenSymbols.add(symbol);

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isParameter(declaration)) {
      if (
        isPatternOwnedParameterDeclaration(declaration, context) ||
        isReactiveCollectionCallbackParameter(declaration, context)
      ) {
        return true;
      }
      continue;
    }

    if (ts.isBindingElement(declaration)) {
      const parameter = getOwningParameterDeclaration(declaration);
      if (
        parameter &&
        (
          isPatternOwnedParameterDeclaration(parameter, context) ||
          isReactiveCollectionCallbackParameter(parameter, context)
        )
      ) {
        return true;
      }
      // Also check if the binding element is from a variable declaration
      // with a reactive initializer (e.g. const { items } = wish(...).result!)
      let parent: ts.Node = declaration;
      while (
        ts.isBindingElement(parent) ||
        ts.isObjectBindingPattern(parent) ||
        ts.isArrayBindingPattern(parent)
      ) {
        parent = parent.parent;
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer) {
        if (
          isReactiveMapOrigin(parent.initializer, context, seenSymbols)
        ) {
          return true;
        }
      }
    }

    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (isReactiveMapOrigin(declaration.initializer, context, seenSymbols)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Create the final pattern call with params object.
 */
/**
 * Create the final pattern call with params object.
 */
function createPatternCallWithParams(
  methodCall: ts.CallExpression,
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
    rewriteArrayMethodCallbackExpressionSites(transformedBody, context),
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
  context.markAsArrayMethodCallback(newCallback);

  // Build schema using SchemaFactory
  const schemaFactory = new SchemaFactory(context);
  const callbackParamTypeNode = schemaFactory.createArrayMethodCallbackSchema(
    methodCall,
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
  const typeArgs = [callbackParamTypeNode];
  if (resultTypeNode) {
    typeArgs.push(resultTypeNode);
  }

  const patternCall = context.ctHelpers.createHelperCall(
    "pattern",
    methodCall,
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

  if (!ts.isPropertyAccessExpression(methodCall.expression)) {
    throw new Error(
      "Expected methodCall.expression to be a PropertyAccessExpression",
    );
  }

  // Visit the array expression
  const visitedArrayExpr = ts.visitNode(
    methodCall.expression.expression,
    visitor,
    ts.isExpression,
  ) ?? methodCall.expression.expression;
  const loweredArrayExpr = lowerMapReceiverMemberAccess(
    visitedArrayExpr,
    context,
  );

  const originalMethodName =
    (methodCall.expression as ts.PropertyAccessExpression).name.text;
  const targetMethodName = METHOD_TO_WITH_PATTERN[originalMethodName] ??
    "mapWithPattern";
  const mapWithPatternAccess = factory.createPropertyAccessExpression(
    loweredArrayExpr,
    factory.createIdentifier(targetMethodName),
  );

  const args: ts.Expression[] = [patternCall, paramsObject];
  if (methodCall.arguments.length > 1) {
    const thisArg = ts.visitNode(
      methodCall.arguments[1],
      visitor,
      ts.isExpression,
    );
    if (thisArg) {
      args.push(thisArg);
    }
  }

  const mapWithPatternCall = factory.createCallExpression(
    mapWithPatternAccess,
    methodCall.typeArguments,
    args,
  );

  // Register the result type for the mapWithPattern call so schema injection
  // can find it when this call is used inside ifElse branches
  if (typeRegistry) {
    // The result type of mapWithPattern is the same as the original map call
    const mapResultType = context.checker.getTypeAtLocation(methodCall);
    registerSyntheticCallType(mapWithPatternCall, mapResultType, typeRegistry);
  }

  return mapWithPatternCall;
}

/**
 * Transform an array method callback for OpaqueRef arrays.
 * Always transforms to use pattern + the WithPattern variant, even with no
 * captures, to ensure callback parameters become opaque.
 */
export function transformArrayMethodCallback(
  methodCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression {
  const { checker } = context;

  // Mark the authored callback before visiting nested expressions so context
  // classification during this transform can treat nested array method calls as
  // being inside a transformed array method callback.
  context.markAsArrayMethodCallback(callback);

  // Collect captured variables from the callback
  const collector = new CaptureCollector(checker);
  const { captureTree } = collector.analyzeCurrentAndOriginal(callback);

  // Get callback parameters
  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const indexParam = originalParams[1]; // May be undefined
  const arrayParam = originalParams[2]; // May be undefined

  // IMPORTANT: First, recursively transform any nested array method callbacks BEFORE we change
  // parameter names. This ensures nested callbacks can properly detect captures from
  // parent callback scope. Reuse the same visitor for consistency.
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Create the final pattern call with params
  return createPatternCallWithParams(
    methodCall,
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
