import ts from "typescript";

import {
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
): ts.Expression {
  const visitor = (child: ts.Node): ts.Node => {
    if (ts.isExpression(child)) {
      const analysis = analyze(child);
      if (analysis.containsOpaqueRef && analysis.requiresRewrite) {
        const result = rewriteExpression({
          expression: child,
          analysis,
          context,
          analyze,
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
  const emitterContext: EmitterContext = {
    rewriteChildren(node: ts.Expression): ts.Expression {
      return rewriteChildExpressions(
        node,
        params.context,
        params.analyze,
      );
    },
    ...params,
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
