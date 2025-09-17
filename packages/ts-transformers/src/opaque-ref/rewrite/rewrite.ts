import ts from "typescript";

import { normaliseDependencies } from "../normalise.ts";
import type { Emitter, EmitterResult, RewriteParams } from "./types.ts";
import { emitPropertyAccess } from "./property-access.ts";
import { emitBinaryExpression } from "./binary-expression.ts";
import { emitCallExpression } from "./call-expression.ts";
import { emitTemplateExpression } from "./template-expression.ts";
import { emitConditionalExpression } from "./conditional-expression.ts";
import { emitElementAccessExpression } from "./element-access-expression.ts";
import type { OpaqueRefHelperName } from "../transforms.ts";

const EMITTERS: readonly Emitter[] = [
  emitPropertyAccess,
  emitBinaryExpression,
  emitCallExpression,
  emitTemplateExpression,
  emitConditionalExpression,
  emitElementAccessExpression,
];

export function rewriteExpression(
  params: RewriteParams,
): EmitterResult | undefined {
  const dependencies = normaliseDependencies(params.analysis.graph);
  for (const emitter of EMITTERS) {
    const result = emitter({
      expression: params.expression,
      dependencies,
      analysis: params.analysis,
      context: params.context,
    });
    if (result) {
      return result;
    }
  }

  const nestedHelpers = new Set<OpaqueRefHelperName>();

  const visit = (node: ts.Node): ts.Node => {
    if (ts.isExpression(node)) {
      const analysis = params.context.analyze(node);
      if (analysis.containsOpaqueRef && analysis.requiresRewrite) {
        const result = rewriteExpression({
          expression: node,
          analysis,
          context: params.context,
        });
        if (result) {
          for (const helper of result.helpers) {
            nestedHelpers.add(helper);
          }
          return result.expression;
        }
      }
    }
    return ts.visitEachChild(node, visit, params.context.transformation);
  };

  const rewritten = ts.visitEachChild(
    params.expression,
    visit,
    params.context.transformation,
  );

  if (rewritten !== params.expression) {
    return {
      expression: rewritten,
      helpers: nestedHelpers,
    };
  }
  return undefined;
}
