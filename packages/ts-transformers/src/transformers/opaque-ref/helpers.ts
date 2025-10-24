import ts from "typescript";

import { createDeriveCall } from "../builtins/derive.ts";
import {
  type DataFlowAnalysis,
  detectCallKind,
  getExpressionText,
  type NormalizedDataFlow,
} from "../../ast/mod.ts";
import type { BindingPlan } from "./bindings.ts";
import { TransformationContext } from "../../core/mod.ts";

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

      // Don't filter identifiers without symbols here - they might be synthetic
      // identifiers created by transformers (like map callback parameters), or
      // they might be legitimate identifiers that lost their symbols. Let
      // filterRelevantDataFlows handle this with more context about all the
      // dataflows being analyzed together.
      if (!symbol) {
        return false;
      }

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

export function filterRelevantDataFlows(
  dataFlows: readonly NormalizedDataFlow[],
  analysis: DataFlowAnalysis,
  context: TransformationContext,
): NormalizedDataFlow[] {
  // Check if we have identifiers without symbols (synthetic identifiers created by transformers)
  const hasSyntheticRoot = (expr: ts.Expression): boolean => {
    let current = expr;
    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
    }
    if (ts.isIdentifier(current)) {
      const symbol = context.checker.getSymbolAtLocation(current);
      // No symbol means it's likely a synthetic identifier
      return !symbol;
    }
    return false;
  };

  const syntheticDataFlows = dataFlows.filter((df) =>
    hasSyntheticRoot(df.expression)
  );

  // If we have synthetic dataflows (e.g., element, index, array from map callbacks),
  // these are identifiers without symbols that were created by ClosureTransformer.
  // We need to determine if they're being used in the correct scope or if they leaked.
  if (syntheticDataFlows.length > 0) {
    // Check if the synthetic identifiers are standard map callback parameter names
    const hasSyntheticMapParams = syntheticDataFlows.some((df) => {
      let rootExpr: ts.Expression = df.expression;
      while (
        ts.isPropertyAccessExpression(rootExpr) ||
        ts.isElementAccessExpression(rootExpr)
      ) {
        rootExpr = rootExpr.expression;
      }
      if (ts.isIdentifier(rootExpr)) {
        const name = rootExpr.text;
        // Standard map callback parameter names created by ClosureTransformer
        return name === "element" || name === "index" || name === "array";
      }
      return false;
    });

    if (hasSyntheticMapParams) {
      // We have synthetic map callback params. These could be:
      // 1. Inside a map callback (keep them)
      // 2. In outer scope where they leaked (filter them out)

      const nonSyntheticDataFlows = dataFlows.filter((df) => !hasSyntheticRoot(df.expression));

      // If we have ONLY synthetic dataflows, we're definitely inside a map callback
      if (nonSyntheticDataFlows.length === 0) {
        // Pure synthetic - we're inside a map callback, keep all
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
          return true;
        });
      }

      // We have both synthetic and non-synthetic. This could be:
      // 1. Inside a map callback with captures (keep all)
      // 2. Outer scope with leaked synthetic params (filter synthetics)

      // Try to find if any dataflow is from a scope with parameters that's a marked callback
      const isInMarkedCallback = dataFlows.some((df) => {
        const scope = analysis.graph.scopes.find((s) => s.id === df.scopeId);
        if (!scope || scope.parameters.length === 0) return false;

        const firstParam = scope.parameters[0];
        if (!firstParam || !firstParam.declaration) return false;

        let node: ts.Node | undefined = firstParam.declaration.parent;
        while (node) {
          if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            return context.isMapCallback(node);
          }
          node = node.parent;
        }
        return false;
      });

      if (isInMarkedCallback) {
        // Inside a map callback - keep all except ignored params
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
          return true;
        });
      }

      // Synthetic map params in outer scope - filter them out
      return dataFlows.filter((df) => !hasSyntheticRoot(df.expression));
    }
  }

  // No synthetic dataflows, use standard filtering
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
    // Keep all other dataflows, including builder parameters and map parameters
    // Both are OpaqueRefs that may need to be included in derive calls
    return true;
  });
}

export function createDeriveCallForExpression(
  expression: ts.Expression,
  plan: BindingPlan,
  context: TransformationContext,
): ts.Expression | undefined {
  if (plan.entries.length === 0) return undefined;

  // Don't wrap expressions that are already derive calls
  if (ts.isCallExpression(expression)) {
    const callKind = detectCallKind(expression, context.checker);
    if (callKind?.kind === "derive") {
      return undefined;
    }
  }

  if (!plan.usesObjectBinding && plan.entries.length === 1) {
    const [entry] = plan.entries;
    if (entry && entry.dataFlow.expression === expression) {
      return undefined;
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
        if (
          ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)
        ) {
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
    const canonicalText = getExpressionText(canonical);
    addRef(canonical);
    for (const occurrence of entry.dataFlow.occurrences) {
      const normalized = normalizeForCanonical(occurrence.expression);
      if (getExpressionText(normalized) === canonicalText) {
        addRef(normalized);
      }
    }
  }

  const deriveCall = createDeriveCall(expression, refs, {
    factory: context.factory,
    tsContext: context.tsContext,
    ctHelpers: context.ctHelpers,
  });

  return deriveCall;
}
