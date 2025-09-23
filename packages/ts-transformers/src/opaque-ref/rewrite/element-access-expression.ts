import ts from "typescript";

import type { OpaqueRefHelperName } from "../transforms.ts";
import type { Emitter } from "./types.ts";
import { createBindingPlan } from "./bindings.ts";
import {
  createDeriveCallForExpression,
  filterRelevantDataFlows,
} from "./helpers.ts";

export const emitElementAccessExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
}) => {
  if (!ts.isElementAccessExpression(expression)) return undefined;
  if (dataFlows.all.length === 0) return undefined;

  console.log(`[EmitElementAccess] "${expression.getText()}"`);
  console.log(`  - dataFlows.all.length: ${dataFlows.all.length}`);
  console.log(`  - analysis.requiresRewrite: ${analysis.requiresRewrite}`);

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  console.log(`  - relevantDataFlows.length: ${relevantDataFlows.length}`);

  if (relevantDataFlows.length === 0) return undefined;

  // Check if this is a static index access
  const argumentExpression = expression.argumentExpression;
  const isStaticIndex = argumentExpression &&
    ts.isExpression(argumentExpression) &&
    (ts.isLiteralExpression(argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(argumentExpression));

  console.log(`  - isStaticIndex: ${isStaticIndex}`);
  console.log(`  - Should skip wrapping: ${isStaticIndex && !analysis.requiresRewrite}`);

  // If it's a static index and doesn't require rewrite, don't wrap it
  if (isStaticIndex && !analysis.requiresRewrite) {
    console.log(`  -> Skipping wrapping for static index`);
    return undefined;
  }

  const plan = createBindingPlan(relevantDataFlows);
  const rewritten = createDeriveCallForExpression(expression, plan, context);
  if (rewritten === expression) return undefined;

  return {
    expression: rewritten,
    helpers: new Set<OpaqueRefHelperName>(["derive"]),
  };
};
