import ts from "typescript";

import {
  classifyArrayMethodCall,
  detectCallKind,
  getEnclosingFunctionLikeDeclaration,
  getTypeAtLocationWithFallback,
  hasReactiveCollectionProvenance,
  isConsumedByTerminalChainCall,
} from "../../ast/mod.ts";
import type { TransformationContext } from "../../core/mod.ts";
import {
  classifyReactiveReceiverKind,
  shouldRewriteCollectionMethod,
} from "../../policy/mod.ts";

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
      syntheticReactiveCollectionRegistry:
        context.options.syntheticReactiveCollectionRegistry,
    },
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
export function shouldTransformArrayMethod(
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

  const targetType = getTypeAtLocationWithFallback(
    mapTarget,
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
