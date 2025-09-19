import ts from "typescript";

import type { NormalisedDataFlow } from "../normalise.ts";

export interface BindingPlanEntry {
  readonly dataFlow: NormalisedDataFlow;
  readonly propertyName: string;
  readonly paramName: string;
}

export interface BindingPlan {
  readonly entries: readonly BindingPlanEntry[];
  readonly paramBindings: ReadonlyMap<ts.Expression, string>;
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

function sanitiseName(
  candidate: string,
  fallback: string,
  used: Set<string>,
): string {
  let base = candidate.replace(/[^A-Za-z0-9_]/g, "_");
  base = base.replace(/^_+/, "");
  if (base.length === 0) base = fallback;
  const firstChar = base.charAt(0);
  if (!/[A-Za-z_]/.test(firstChar)) {
    base = `${fallback}_${used.size + 1}`;
  }
  let name = base;
  let suffix = 1;
  while (used.has(name)) {
    name = `${base}_${suffix++}`;
  }
  used.add(name);
  return name;
}

function createIdentifierParamName(
  raw: string,
  used: Set<string>,
): string {
  let base = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (base.length === 0) base = "ref";
  const firstChar = base.charAt(0);
  if (!/[A-Za-z_]/.test(firstChar)) {
    base = `_${base}`;
  }
  let name = base;
  let suffix = 1;
  while (used.has(name)) {
    name = `${base}_${suffix++}`;
  }
  used.add(name);
  return name;
}

function createGeneratedParamName(
  index: number,
  used: Set<string>,
): string {
  const base = `_v${index + 1}`;
  let name = base;
  let suffix = 1;
  while (used.has(name)) {
    name = `${base}_${suffix++}`;
  }
  used.add(name);
  return name;
}

export function createBindingPlan(
  dataFlows: readonly NormalisedDataFlow[],
): BindingPlan {
  const usedPropertyNames = new Set<string>();
  const usedParamNames = new Set<string>();
  const entries: BindingPlanEntry[] = [];
  const paramBindings = new Map<ts.Expression, string>();

  dataFlows.forEach((dataFlow, index) => {
    const base = deriveBaseName(dataFlow.expression, index);
    const fallback = `ref${index + 1}`;
    const propertyName = sanitiseName(base, fallback, usedPropertyNames);

    const paramName = ts.isIdentifier(dataFlow.expression)
      ? createIdentifierParamName(dataFlow.expression.text, usedParamNames)
      : createGeneratedParamName(index, usedParamNames);

    const sourceFile = dataFlow.expression.getSourceFile();
    const dataFlowText = dataFlow.expression.getText(sourceFile);

    entries.push({
      dataFlow,
      propertyName,
      paramName,
    });

    paramBindings.set(dataFlow.expression, paramName);

    for (const occurrence of dataFlow.occurrences) {
      const occurrenceText = occurrence.expression.getText(
        occurrence.expression.getSourceFile(),
      );
      if (occurrenceText === dataFlowText) {
        paramBindings.set(occurrence.expression, paramName);
      }
    }
  });

  return {
    entries,
    paramBindings,
    usesObjectBinding: entries.length > 1,
  };
}
