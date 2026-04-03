import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";

export const emitTemplateExpression = ({
  expression,
  dataFlows,
  context,
  inSafeContext,
  preferDeriveWrappers,
}: EmitterContext) => {
  if (!ts.isTemplateExpression(expression)) return undefined;

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  if (dataFlows.length === 0) return undefined;

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferDeriveWrapper: preferDeriveWrappers,
    },
  );
};
