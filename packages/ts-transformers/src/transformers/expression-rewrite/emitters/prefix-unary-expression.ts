import ts from "typescript";

import type { Emitter } from "../types.ts";
import {
  createReactiveWrapperForExpression,
  getRelevantDataFlows,
} from "../rewrite-helpers.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analysis,
  analyze,
  inSafeContext,
  preferDeriveWrappers,
}) => {
  if (!ts.isPrefixUnaryExpression(expression)) return undefined;

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  if (expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return undefined;
  }
  if (dataFlows.all.length === 0) return undefined;

  let relevantDataFlows = dataFlows.all;

  if (relevantDataFlows.length === 0 && analysis.containsOpaqueRef) {
    const fallbackAnalysis = analyze(expression.operand);
    relevantDataFlows = getRelevantDataFlows(fallbackAnalysis, context);

    if (relevantDataFlows.length === 0) return undefined;
  } else if (relevantDataFlows.length === 0) {
    return undefined;
  }

  return createReactiveWrapperForExpression(
    expression,
    relevantDataFlows,
    context,
    {
      preferDeriveWrapper: preferDeriveWrappers,
    },
  );
};
