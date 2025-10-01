import ts from "typescript";

import { normalizeDataFlows } from "../../ast/mod.ts";
import type {
  Emitter,
  EmitterContext,
  EmitterResult,
  OpaqueRefHelperName,
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
  helpers: Set<OpaqueRefHelperName>,
): ts.Expression {
  const visitor = (child: ts.Node): ts.Node => {
    if (ts.isExpression(child)) {
      const analysis = context.analyze(child);
      if (analysis.containsOpaqueRef && analysis.requiresRewrite) {
        const result = rewriteExpression({
          expression: child,
          analysis,
          context,
        });
        if (result) {
          for (const helper of result.helpers) helpers.add(helper);
          return result.expression;
        }
      }
    }
    return ts.visitEachChild(child, visitor, context.transformation);
  };

  return ts.visitEachChild(
    node,
    visitor,
    context.transformation,
  ) as ts.Expression;
}

export function rewriteExpression(
  params: RewriteParams,
): EmitterResult | undefined {
  const dataFlows = normalizeDataFlows(
    params.analysis.graph,
    params.analysis.dataFlows,
  );

  const helperSet = new Set<OpaqueRefHelperName>();
  const emitterContext: EmitterContext = {
    ...params.context,
    rewriteChildren(node: ts.Expression): ts.Expression {
      return rewriteChildExpressions(node, params.context, helperSet);
    },
  };
  for (const emitter of EMITTERS) {
    const result = emitter({
      expression: params.expression,
      dataFlows,
      analysis: params.analysis,
      context: emitterContext,
    });
    if (result) {
      for (const helper of result.helpers) helperSet.add(helper);
      return {
        expression: result.expression,
        helpers: new Set(helperSet),
      };
    }
  }
  return undefined;
}
