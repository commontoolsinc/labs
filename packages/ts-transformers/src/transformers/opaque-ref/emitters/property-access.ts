import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import {
  createReactiveWrapperForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";
import { isSafeEventHandlerCall } from "../../../ast/mod.ts";

export function emitPropertyAccess(
  params: EmitterContext,
): ts.Expression | undefined {
  const {
    expression,
    dataFlows,
    context,
    inSafeContext,
    preferDeriveWrappers,
  } = params;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  if (dataFlows.all.length === 0) return undefined;
  if (
    expression.parent &&
    ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression
  ) {
    if (!isSafeEventHandlerCall(expression.parent)) return undefined;
  }

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    params.analysis,
    context,
  );
  if (relevantDataFlows.length === 0) {
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
}
