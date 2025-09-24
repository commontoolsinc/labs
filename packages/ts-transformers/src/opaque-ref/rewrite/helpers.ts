import ts from "typescript";

import { createDeriveCall } from "../transforms.ts";
import { detectCallKind } from "../call-kind.ts";
import type { BindingPlan } from "./bindings.ts";
import type { RewriteContext } from "./types.ts";
import type { NormalizedDataFlow } from "../normalize.ts";
import type { DataFlowAnalysis } from "../dataflow.ts";
import { isFunctionParameter } from "../types.ts";

function originatesFromIgnoredParameter(
  expression: ts.Expression,
  scopeId: number,
  analysis: DataFlowAnalysis,
  checker: ts.TypeChecker,
): boolean {
  const scope = analysis.graph.scopes.find((candidate) =>
    candidate.id === scopeId
  );
  if (!scope) return false;

  const isIgnoredSymbol = (symbol: ts.Symbol | undefined): boolean => {
    if (!symbol) return false;
    const symbolName = symbol.getName();
    return scope.parameters.some((parameter) => {
      if (parameter.symbol === symbol || parameter.name === symbolName) {
        if (
          parameter.declaration &&
          getOpaqueCallKindForParameter(parameter.declaration, checker)
        ) {
          return false;
        }
        return true;
      }
      return false;
    });
  };

  const inner = (expr: ts.Expression): boolean => {
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr);
      return isIgnoredSymbol(symbol);
    }
    if (
      ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)
    ) {
      return inner(expr.expression);
    }
    if (ts.isCallExpression(expr)) {
      return inner(expr.expression);
    }
    return false;
  };

  return inner(expression);
}

function getOpaqueCallKindForParameter(
  declaration: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): "builder" | "array-map" | undefined {
  let functionNode: ts.Node | undefined = declaration.parent;
  while (functionNode && !ts.isFunctionLike(functionNode)) {
    functionNode = functionNode.parent;
  }
  if (!functionNode) return undefined;

  let candidate: ts.Node | undefined = functionNode.parent;
  while (candidate && !ts.isCallExpression(candidate)) {
    candidate = candidate.parent;
  }
  if (!candidate) return undefined;

  const callKind = detectCallKind(candidate, checker);
  if (callKind?.kind === "builder" || callKind?.kind === "array-map") {
    return callKind.kind;
  }
  return undefined;
}

function resolvesToParameterOfKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  kind: "array-map" | "builder",
): boolean {
  let current: ts.Expression = expression;
  let symbol: ts.Symbol | undefined;
  let isRootIdentifierOnly = true;
  const allowPropertyTraversal = kind === "array-map";
  while (true) {
    if (ts.isIdentifier(current)) {
      symbol = checker.getSymbolAtLocation(current);
      break;
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current)
    ) {
      if (!allowPropertyTraversal) {
        isRootIdentifierOnly = false;
      }
      current = current.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    break;
  }

  if (!symbol) return false;
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;
  return declarations.some((declaration) =>
    ts.isParameter(declaration) &&
    getOpaqueCallKindForParameter(declaration, checker) === kind &&
    (kind === "array-map" || isRootIdentifierOnly)
  );
}

function resolvesToMapParameter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return resolvesToParameterOfKind(expression, checker, "array-map");
}

function resolvesToBuilderParameter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return resolvesToParameterOfKind(expression, checker, "builder");
}

export function filterRelevantDataFlows(
  dataFlows: readonly NormalizedDataFlow[],
  analysis: DataFlowAnalysis,
  context: RewriteContext,
): NormalizedDataFlow[] {
  const isParameterExpression = (expression: ts.Expression): boolean => {
    let current: ts.Expression = expression;
    while (true) {
      if (ts.isIdentifier(current)) {
        return isFunctionParameter(current, context.checker);
      }
      if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current) ||
        ts.isCallExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      return false;
    }
  };

  return dataFlows.filter((dataFlow) => {
    if (
      originatesFromIgnoredParameter(
        dataFlow.expression,
        dataFlow.scopeId,
        analysis,
        context.checker,
      )
    ) {
      return false;
    }
    if (isParameterExpression(dataFlow.expression)) {
      if (resolvesToMapParameter(dataFlow.expression, context.checker)) {
        return true;
      }
      if (resolvesToBuilderParameter(dataFlow.expression, context.checker)) {
        return false;
      }
      return false;
    }
    if (resolvesToBuilderParameter(dataFlow.expression, context.checker)) {
      return false;
    }
    return true;
  });
}

export function createDeriveCallForExpression(
  expression: ts.Expression,
  plan: BindingPlan,
  context: RewriteContext,
): ts.Expression {
  if (plan.entries.length === 0) return expression;

  // Don't wrap expressions that are already derive calls
  if (ts.isCallExpression(expression)) {
    const callKind = detectCallKind(expression, context.checker);
    if (callKind?.kind === "derive") {
      return expression;
    }
  }

  if (!plan.usesObjectBinding && plan.entries.length === 1) {
    const [entry] = plan.entries;
    if (entry && entry.dataFlow.expression === expression) {
      return expression;
    }
  }

  const refs: ts.Expression[] = [];
  const seen = new Set<ts.Node>();
  const addRef = (expr: ts.Expression): void => {
    if (seen.has(expr)) return;
    seen.add(expr);
    refs.push(expr);
  };
  const normalizeForCanonical = (expr: ts.Expression): ts.Expression => {
    let current: ts.Expression = expr;
    while (true) {
      if (ts.isParenthesizedExpression(current)) {
        current = current.expression;
        continue;
      }
      if (
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          current = callee.expression;
          continue;
        }
      }
      if (
        ts.isPropertyAccessExpression(current) &&
        current.parent &&
        ts.isCallExpression(current.parent) &&
        current.parent.expression === current
      ) {
        current = current.expression;
        continue;
      }
      break;
    }
    return current;
  };
  for (const entry of plan.entries) {
    const canonical = entry.dataFlow.expression;
    const canonicalText = canonical.getText(canonical.getSourceFile());
    addRef(canonical);
    for (const occurrence of entry.dataFlow.occurrences) {
      const normalized = normalizeForCanonical(occurrence.expression);
      if (
        normalized.getText(normalized.getSourceFile()) === canonicalText
      ) {
        addRef(normalized);
      }
    }
  }

  const deriveCall = createDeriveCall(expression, refs, {
    factory: context.factory,
    sourceFile: context.sourceFile,
    context: context.transformation,
  });

  return deriveCall ?? expression;
}
