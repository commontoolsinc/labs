import { normaliseDependencies } from "../normalise.ts";
import type { Emitter, EmitterResult, RewriteParams } from "./types.ts";
import { emitPropertyAccess } from "./property-access.ts";
import { emitBinaryExpression } from "./binary-expression.ts";
import { emitCallExpression } from "./call-expression.ts";
import { emitTemplateExpression } from "./template-expression.ts";
import { emitConditionalExpression } from "./conditional-expression.ts";
import { emitElementAccessExpression } from "./element-access-expression.ts";

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
  return undefined;
}
