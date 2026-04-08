import ts from "typescript";

import type { Emitter } from "../types.ts";
import {
  classifyArrayMethodResultSinkCall,
  classifyArrayMethodResultSinkReceiverChainCall,
  detectCallKind,
} from "../../../ast/mod.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import { rewriteHelperOwnedExpression } from "./helper-owned-expression.ts";

function isZeroArgInlineIifeCall(
  expression: ts.CallExpression,
): boolean {
  if (expression.arguments.length !== 0) {
    return false;
  }

  let callee: ts.Expression = expression.expression;
  while (ts.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }

  return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee);
}

function getConditionalHelperArgLabel(
  helperName: "ifElse" | "when" | "unless",
  index: number,
): string {
  if (helperName === "ifElse") {
    if (index === 0) return "ifElse condition";
    if (index === 1) return "ifElse true branch";
    return "ifElse false branch";
  }

  if (helperName === "when") {
    return index === 0 ? "when condition" : "when value";
  }

  return index === 0 ? "unless condition" : "unless value";
}

function shouldFilterNestedLocalsForCallWrapper(
  expression: ts.CallExpression,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
): boolean {
  const reactiveContext = context.getReactiveContext(expression);
  if (
    reactiveContext.kind !== "pattern" ||
    (reactiveContext.owner !== "pattern" && reactiveContext.owner !== "render")
  ) {
    return false;
  }

  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (
    callbackContext &&
    (context.isArrayMethodCallback(callbackContext.callback) ||
      detectCallKind(callbackContext.call, context.checker)?.kind ===
        "array-method")
  ) {
    return true;
  }

  const sinkCall = classifyArrayMethodResultSinkCall(
    expression,
    context.checker,
  );
  if (sinkCall?.sink === "join") {
    const callee = expression.expression;
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) {
      return false;
    }

    const receiverAnalysis = analyze(callee.expression);
    return receiverAnalysis.containsOpaqueRef;
  }

  const sinkReceiverChain = classifyArrayMethodResultSinkReceiverChainCall(
    expression,
    context.checker,
  );
  if (!sinkReceiverChain || sinkReceiverChain.sinkCall.sink !== "join") {
    return false;
  }

  const callee = expression.expression;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }

  const receiverAnalysis = analyze(callee.expression);
  return receiverAnalysis.containsOpaqueRef;
}

export const emitCallExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analysis,
  analyze,
  rewriteChildren,
  inSafeContext,
  reactiveContextKind,
  preferDeriveWrappers,
}) => {
  if (!ts.isCallExpression(expression)) return undefined;
  if (dataFlows.length === 0) return undefined;

  const hint = analysis.rewriteHint;
  const callKind = detectCallKind(expression, context.checker);
  // Synthetic when/unless/ifElse calls created by earlier lowering passes
  // already own their argument rewriting decisions and must not be reprocessed.
  const isAuthoredCall = expression.pos >= 0;
  const conditionalHelperName: "ifElse" | "when" | "unless" | undefined =
    hint?.kind === "call-if-else" ? "ifElse" : (
        callKind?.kind === "ifElse" ||
        callKind?.kind === "when" ||
        callKind?.kind === "unless"
      )
      ? callKind.kind
      : undefined;

  if (hint?.kind === "skip-call-rewrite") {
    if (hint.reason === "array-method") {
      // For array method calls (e.g., state.items.filter(...).map(...)),
      // we don't wrap the method call itself, but we DO need to rewrite
      // the call chain before the method to wrap reactive expressions

      // If the callee is a property access (e.g., ...filter(...).map),
      // recursively rewrite the entire callee to handle wrapped expressions
      const rewrittenCallee = rewriteChildren(expression.expression);

      if (rewrittenCallee !== expression.expression) {
        // The callee was rewritten, update the map call
        return context.factory.updateCallExpression(
          expression,
          rewrittenCallee as ts.LeftHandSideExpression,
          expression.typeArguments,
          expression.arguments,
        );
      }

      // No changes needed
      return undefined;
    }
    return undefined;
  }

  if (conditionalHelperName) {
    if (!isAuthoredCall) {
      return undefined;
    }

    const rewrittenCallee = rewriteChildren(expression.expression);
    const rewrittenArgs: ts.Expression[] = [];
    let changed = rewrittenCallee !== expression.expression;

    expression.arguments.forEach((argument, index) => {
      const updated = !inSafeContext &&
          reactiveContextKind === "pattern"
        ? rewriteHelperOwnedExpression({
          expression: argument,
          containerLabel: getConditionalHelperArgLabel(
            conditionalHelperName,
            index,
          ),
          assertContainer: expression,
          context,
          analyze,
          rewriteChildren,
        })
        : rewriteChildren(argument) || argument;
      if (updated !== argument) changed = true;
      rewrittenArgs.push(updated);
    });

    if (!changed) return undefined;

    return context.factory.updateCallExpression(
      expression,
      rewrittenCallee,
      expression.typeArguments,
      rewrittenArgs,
    );
  }

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) {
    return undefined;
  }

  // Preserve authored zero-arg IIFEs in the derive-preferring post-closure
  // path so the existing inner expression-site machinery can decompose their
  // local aliases instead of forcing a blanket wrapper around the whole call.
  if (
    preferDeriveWrappers &&
    isAuthoredCall &&
    isZeroArgInlineIifeCall(expression)
  ) {
    const rewritten = rewriteChildren(expression);
    return rewritten !== expression ? rewritten : undefined;
  }

  if (dataFlows.length === 0) return undefined;

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      filterNestedFunctionLocalCaptures: shouldFilterNestedLocalsForCallWrapper(
        expression,
        context,
        analyze,
      ),
      preferDeriveWrapper: preferDeriveWrappers,
    },
  );
};
