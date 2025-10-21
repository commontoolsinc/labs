import ts from "typescript";

import type { NormalizedDataFlow } from "../../ast/mod.ts";

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
    return expression.getText().replace(/\./g, "_");
  }
  return `ref${index + 1}`;
}

interface UniqueNameOptions {
  readonly trimLeadingUnderscores?: boolean;
}

function createUniqueIdentifier(
  candidate: string,
  fallback: string,
  used: Set<string>,
  options: UniqueNameOptions = {},
): string {
  let base = candidate.replace(/[^A-Za-z0-9_]/g, "_");
  if (options.trimLeadingUnderscores) {
    base = base.replace(/^_+/, "");
  }
  if (base.length === 0) {
    base = fallback;
  }
  if (!/^[A-Za-z_]/.test(base.charAt(0))) {
    base = fallback;
  }

  let name = base;
  let suffix = 1;
  while (used.has(name)) {
    name = `${base}_${suffix++}`;
  }
  used.add(name);
  return name;
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
    const propertyName = createUniqueIdentifier(
      base,
      fallback,
      usedPropertyNames,
      { trimLeadingUnderscores: true },
    );

    const paramName = ts.isIdentifier(dataFlow.expression)
      ? createUniqueIdentifier(
        dataFlow.expression.text,
        `_v${index + 1}`,
        usedParamNames,
      )
      : createUniqueIdentifier(
        `_v${index + 1}`,
        `_v${index + 1}`,
        usedParamNames,
      );

    entries.push({ dataFlow, propertyName, paramName });
  });

  return {
    entries,
    usesObjectBinding: entries.length > 1,
  };
}
