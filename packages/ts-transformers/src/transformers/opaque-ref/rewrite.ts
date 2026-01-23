import ts from "typescript";

import {
  isInsideSafeCallbackWrapper,
  normalizeDataFlows,
  visitEachChildWithJsx,
} from "../../ast/mod.ts";

import type {
  AnalyzeFn,
  Emitter,
  EmitterContext,
  RewriteParams,
} from "./types.ts";
import {
  emitBinaryExpression,
  emitCallExpression,
  emitConditionalExpression,
  emitContainerExpression,
  emitElementAccessExpression,
  emitPrefixUnaryExpression,
  emitPropertyAccess,
  emitTemplateExpression,
} from "./emitters/mod.ts";

const EMITTERS: readonly Emitter[] = [
  emitPropertyAccess,
  emitBinaryExpression,
  emitCallExpression,
  emitTemplateExpression,
  emitConditionalExpression,
  emitElementAccessExpression,
  emitPrefixUnaryExpression,
  emitContainerExpression,
];

function rewriteChildExpressions(
  node: ts.Expression,
  context: RewriteParams["context"],
  analyze: AnalyzeFn,
  inSafeContext?: boolean,
): ts.Expression {
  const visitor = (child: ts.Node): ts.Node => {
    if (ts.isExpression(child)) {
      const analysis = analyze(child);
      if (analysis.containsOpaqueRef && analysis.requiresRewrite) {
        // Skip wrapping if inside a safe callback wrapper (computed/derive/action/etc.)
        // This prevents double-wrapping expressions already in a reactive context
        if (isInsideSafeCallbackWrapper(child, context.checker)) {
          return visitEachChildWithJsx(child, visitor, context.tsContext);
        }

        const result = rewriteExpression({
          expression: child,
          analysis,
          context,
          analyze,
          inSafeContext,
        });
        if (result) {
          return result;
        }
      }
    }
    return visitEachChildWithJsx(child, visitor, context.tsContext);
  };

  return visitEachChildWithJsx(
    node,
    visitor,
    context.tsContext,
  ) as ts.Expression;
}

export function rewriteExpression(
  params: RewriteParams,
): ts.Expression | undefined {
  const inSafeContext = params.inSafeContext ?? false;
  const emitterContext: EmitterContext = {
    rewriteChildren(node: ts.Expression): ts.Expression {
      return rewriteChildExpressions(
        node,
        params.context,
        params.analyze,
        inSafeContext,
      );
    },
    ...params,
    inSafeContext,
    dataFlows: normalizeDataFlows(
      params.analysis.graph,
      params.analysis.dataFlows,
    ),
  };

  for (const emitter of EMITTERS) {
    const result = emitter(emitterContext);
    if (result) {
      return result;
    }
  }
  return undefined;
}
