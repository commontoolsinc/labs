import ts from "typescript";

import type { NormalisedDependency } from "../normalise.ts";

export interface BindingPlanEntry {
  readonly dependency: NormalisedDependency;
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
  if (!/[A-Za-z_]/.test(base[0])) {
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
  if (!/[A-Za-z_]/.test(base[0])) {
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
  dependencies: readonly NormalisedDependency[],
): BindingPlan {
  const usedPropertyNames = new Set<string>();
  const usedParamNames = new Set<string>();
  const entries: BindingPlanEntry[] = [];
  const paramBindings = new Map<ts.Expression, string>();

  dependencies.forEach((dependency, index) => {
    const base = deriveBaseName(dependency.expression, index);
    const fallback = `ref${index + 1}`;
    const propertyName = sanitiseName(base, fallback, usedPropertyNames);

    const paramName = ts.isIdentifier(dependency.expression)
      ? createIdentifierParamName(dependency.expression.text, usedParamNames)
      : createGeneratedParamName(index, usedParamNames);

    entries.push({
      dependency,
      propertyName,
      paramName,
    });
    for (const occurrence of dependency.occurrences) {
      paramBindings.set(occurrence.expression, paramName);
    }
  });

  return {
    entries,
    paramBindings,
    usesObjectBinding: entries.length > 1,
  };
}
