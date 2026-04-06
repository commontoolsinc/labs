import ts from "typescript";

import {
  classifyArrayMethodCall,
  getLoweredArrayMethodName,
  getTypeAtLocationWithFallback,
  registerSyntheticCallType,
} from "../../ast/mod.ts";
import type { TransformationContext } from "../../core/mod.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  normalizeBindingName,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import {
  cloneKeyExpression,
  getKnownComputedKeyExpression,
  isCommonFabricKeyIdentifier,
} from "../../utils/reactive-keys.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { buildCaptureParamsObject } from "../utils/capture-scaffold.ts";
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";
import {
  analyzeElementBinding,
  rewriteCallbackBody,
} from "./array-method-utils.ts";
import type { ComputedAliasInfo } from "./array-method-utils.ts";

export interface ArrayMethodCallbackTransformOptions {
  readonly rewriteTransformedBody?: (
    body: ts.ConciseBody,
    context: TransformationContext,
  ) => ts.ConciseBody;
}

function isKnownComputedKey(
  expression: ts.Expression,
  context: TransformationContext,
): expression is ts.Identifier {
  return isCommonFabricKeyIdentifier(expression, context, "NAME") ||
    isCommonFabricKeyIdentifier(expression, context, "UI") ||
    isCommonFabricKeyIdentifier(expression, context, "SELF") ||
    isCommonFabricKeyIdentifier(expression, context, "FS");
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
  options: ArrayMethodCallbackTransformOptions,
): ts.CallExpression {
  const { factory } = context;
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

  const computedAliasNames = new Set(
    elementAnalysis.computedAliases.map((alias) => alias.aliasName),
  );
  const filteredCaptureTree = new Map(
    Array.from(captureTree.entries()).filter(
      ([key]) => !computedAliasNames.has(key),
    ),
  );

  const builder = new PatternBuilder(context);
  builder.registerUsedNames(usedBindingNames);
  builder.setCaptureTree(filteredCaptureTree);

  builder.addParameter(
    "element",
    elementAnalysis.bindingName,
    elementAnalysis.bindingName.kind === ts.SyntaxKind.Identifier &&
      elementAnalysis.bindingName.text === "element"
      ? undefined
      : "element",
  );

  if (indexParam) {
    builder.addParameter(
      "index",
      normalizeBindingName(indexParam.name, factory, usedBindingNames),
    );
  }

  if (arrayParam) {
    builder.addParameter(
      "array",
      normalizeBindingName(arrayParam.name, factory, usedBindingNames),
    );
  }

  const visitedAliases: ComputedAliasInfo[] = elementAnalysis
    .computedAliases.map((info) => {
      const keyExpression = ts.visitNode(
        info.keyExpression,
        visitor,
        ts.isExpression,
      ) ?? info.keyExpression;
      return { ...info, keyExpression };
    });

  const bodyForRewrite = options.rewriteTransformedBody
    ? options.rewriteTransformedBody(transformedBody, context)
    : transformedBody;

  const rewrittenBody = rewriteCallbackBody(
    bodyForRewrite,
    {
      bindingName: elementAnalysis.bindingName,
      elementIdentifier: elementAnalysis.elementIdentifier,
      destructureStatement: elementAnalysis.destructureStatement,
      computedAliases: visitedAliases,
    },
    context,
  );

  const newCallback = builder.buildCallback(callback, rewrittenBody, "params");
  context.markAsArrayMethodCallback(newCallback);

  const schemaFactory = new SchemaFactory(context);
  const callbackParamTypeNode = schemaFactory.createArrayMethodCallbackSchema(
    methodCall,
    elemParam,
    indexParam,
    arrayParam,
    filteredCaptureTree,
  );

  const { checker } = context;
  const typeRegistry = context.options.typeRegistry;
  let resultTypeNode: ts.TypeNode | undefined;

  if (callback.type) {
    resultTypeNode = callback.type;
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

  const typeArgs = [callbackParamTypeNode];
  if (resultTypeNode) {
    typeArgs.push(resultTypeNode);
  }

  const patternCall = context.cfHelpers.createHelperCall(
    "pattern",
    methodCall,
    typeArgs,
    [newCallback],
  );

  const paramsObject = buildCaptureParamsObject(filteredCaptureTree, factory);

  if (!ts.isPropertyAccessExpression(methodCall.expression)) {
    throw new Error(
      "Expected methodCall.expression to be a PropertyAccessExpression",
    );
  }

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

  if (typeRegistry) {
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
  options: ArrayMethodCallbackTransformOptions = {},
): ts.CallExpression {
  const { checker } = context;

  context.markAsArrayMethodCallback(callback);

  const collector = new CaptureCollector(checker);
  const { captureTree } = collector.analyzeCurrentAndOriginal(callback);

  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const indexParam = originalParams[1];
  const arrayParam = originalParams[2];

  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

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
    options,
  );
}
