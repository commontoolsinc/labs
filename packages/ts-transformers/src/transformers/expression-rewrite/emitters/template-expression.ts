import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import {
  createReactiveWrapperForExpression,
  filterRelevantDataFlows,
} from "../rewrite-helpers.ts";

export const emitTemplateExpression = ({
  expression,
  dataFlows,
  analysis,
  context,
  inSafeContext,
  preferDeriveWrappers,
}: EmitterContext) => {
  if (!ts.isTemplateExpression(expression)) return undefined;

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  if (dataFlows.all.length === 0) return undefined;

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  return createReactiveWrapperForExpression(
    expression,
    relevantDataFlows,
    context,
    {
      preferDeriveWrapper: preferDeriveWrappers,
    },
  );
};
