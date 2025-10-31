import ts from "typescript";

import { getExpressionText, type NormalizedDataFlow } from "../../ast/mod.ts";
import { getUniqueIdentifier } from "../../utils/identifiers.ts";

export interface BindingPlanEntry {
  readonly dataFlow: NormalizedDataFlow;
  readonly propertyName: string;
  readonly paramName: string;
}

export interface BindingPlan {
  readonly entries: readonly BindingPlanEntry[];
  readonly usesObjectBinding: boolean;
}

function deriveBaseName(
  expression: ts.Expression,
  index: number,
): string {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    // Use getExpressionText to handle both regular and synthetic nodes
    return getExpressionText(expression).replace(/\./g, "_");
  }
  return `ref${index + 1}`;
}

export function createBindingPlan(
  dataFlows: readonly NormalizedDataFlow[],
): BindingPlan {
  const usedPropertyNames = new Set<string>();
  const usedParamNames = new Set<string>();
  const entries: BindingPlanEntry[] = [];

  dataFlows.forEach((dataFlow, index) => {
    const base = deriveBaseName(dataFlow.expression, index);
    const fallback = `ref${index + 1}`;
    const propertyName = getUniqueIdentifier(base, usedPropertyNames, {
      fallback,
      trimLeadingUnderscores: true,
    });

    const paramCandidate = ts.isIdentifier(dataFlow.expression)
      ? dataFlow.expression.text
      : `_v${index + 1}`;
    const paramName = getUniqueIdentifier(paramCandidate, usedParamNames, {
      fallback: `_v${index + 1}`,
    });

    entries.push({ dataFlow, propertyName, paramName });
  });

  return {
    entries,
    usesObjectBinding: entries.length > 1,
  };
}
