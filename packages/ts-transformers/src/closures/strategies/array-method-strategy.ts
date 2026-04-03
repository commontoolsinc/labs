import ts from "typescript";
import { type TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  classifyArrayMethodCall,
  detectCallKind,
  getEnclosingFunctionLikeDeclaration,
  getLoweredArrayMethodName,
  getTypeAtLocationWithFallback,
  hasReactiveCollectionProvenance,
  isConsumedByTerminalChainCall,
  isFunctionLikeExpression,
  type ReactiveContextInfo,
  registerSyntheticCallType,
} from "../../ast/mod.ts";
import {
  classifyReactiveReceiverKind,
  shouldRewriteCollectionMethod,
} from "../../policy/mod.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
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
import { buildCaptureParamsObject } from "../utils/capture-scaffold.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import {
  cloneKeyExpression,
  getKnownComputedKeyExpression,
  isCommonToolsKeyIdentifier,
} from "../../utils/reactive-keys.ts";
import { rewriteArrayMethodCallbackExpressionSites } from "../../transformers/expression-site-lowering.ts";

export class ArrayMethodStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    _context: TransformationContext,
  ): boolean {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression)
    ) {
      return false;
    }

    const arrayMethodInfo = classifyArrayMethodCall(node);
    return !!arrayMethodInfo && !arrayMethodInfo.lowered;
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

function hasSharedReactiveCollectionProvenance(
  expression: ts.Expression,
  context: TransformationContext,
  options: {
    sameScope?: ts.FunctionLikeDeclaration;
    allowTypeBasedRoot?: boolean;
    allowImplicitReactiveParameters?: boolean;
  } = {},
): boolean {
  return hasReactiveCollectionProvenance(
    expression,
    context.checker,
    {
      ...options,
      typeRegistry: context.options.typeRegistry,
      logger: context.options.logger,
    },
  );
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

  const arrayMethodInfo = classifyArrayMethodCall(methodCall);
  if (!arrayMethodInfo || arrayMethodInfo.lowered) {
    return false;
  }
  const methodName = arrayMethodInfo.family;

  if (isConsumedByTerminalChainCall(methodCall)) {
    return false;
  }

  const mapTarget = methodCall.expression.expression;
  const contextInfo = context.getReactiveContext(methodCall);
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
    contextInfo.kind === "pattern" &&
    hasSharedReactiveCollectionProvenance(mapTarget, context)
  ) {
    return true;
  }

  const enclosingFunction = getEnclosingFunctionLikeDeclaration(methodCall);
  if (
    contextInfo.kind === "compute" &&
    enclosingFunction &&
    hasSharedReactiveCollectionProvenance(mapTarget, context, {
      sameScope: enclosingFunction,
      allowTypeBasedRoot: false,
      allowImplicitReactiveParameters: false,
    })
  ) {
    return true;
  }

  // derive() returns an opaque value at runtime, but checker fallback may see the
  // unwrapped callback result type. Preserve policy by context.
  if (
    ts.isCallExpression(mapTarget) &&
    detectCallKind(mapTarget, context.checker)?.kind === "derive"
  ) {
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
    isCommonToolsKeyIdentifier(expression, context, "SELF") ||
    isCommonToolsKeyIdentifier(expression, context, "FS");
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
  const paramsObject = buildCaptureParamsObject(filteredCaptureTree, factory);

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

  const originalMethodName = classifyArrayMethodCall(methodCall);
  if (!originalMethodName || originalMethodName.lowered) {
    throw new Error("Expected methodCall to be a source array method call");
  }
  const targetMethodName = getLoweredArrayMethodName(
    originalMethodName.family,
  );
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
