import ts from "typescript";

import {
  createIfElseCall,
  replaceOpaqueRefsWithParams,
} from "../transforms.ts";
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

export function createDeriveIdentifier(
  context: RewriteContext,
): ts.Expression {
  return context.factory.createIdentifier("derive");
}

export function createDeriveDataFlowObject(
  plan: BindingPlan,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const properties = plan.entries.map((entry, index) => {
    const dataFlow = entry.dataFlow.expression;
    if (ts.isIdentifier(dataFlow) && dataFlow.text === entry.propertyName) {
      return factory.createShorthandPropertyAssignment(dataFlow, undefined);
    }
    return factory.createPropertyAssignment(
      factory.createIdentifier(entry.propertyName),
      dataFlow,
    );
  });
  return factory.createObjectLiteralExpression(properties, false);
}

function createLambdaParameter(
  plan: BindingPlan,
  factory: ts.NodeFactory,
): ts.ParameterDeclaration {
  if (!plan.usesObjectBinding) {
    const firstEntry = plan.entries[0];
    const paramName = firstEntry?.paramName ?? "_v1";
    return factory.createParameterDeclaration(
      undefined,
      undefined,
      factory.createIdentifier(paramName),
      undefined,
      undefined,
      undefined,
    );
  }

  const bindings = plan.entries.map((entry) =>
    factory.createBindingElement(
      undefined,
      factory.createIdentifier(entry.propertyName),
      factory.createIdentifier(entry.paramName),
      undefined,
    )
  );

  return factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(bindings),
    undefined,
    undefined,
    undefined,
  );
}

export function createDeriveCallForExpression(
  expression: ts.Expression,
  plan: BindingPlan,
  context: RewriteContext,
  options: { wrapConditional?: boolean } = {},
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

  const factory = context.factory;
  const lambdaBody = replaceOpaqueRefsWithParams(
    expression,
    new Map(plan.paramBindings),
    factory,
    context.transformation,
  );

  const arrowFunction = factory.createArrowFunction(
    undefined,
    undefined,
    [createLambdaParameter(plan, factory)],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    lambdaBody,
  );

  const deriveIdentifier = createDeriveIdentifier(context);
  const deriveArgs = plan.usesObjectBinding
    ? [createDeriveDataFlowObject(plan, factory), arrowFunction]
    : [plan.entries[0]!.dataFlow.expression, arrowFunction];

  const callExpression = factory.createCallExpression(
    deriveIdentifier,
    undefined,
    deriveArgs,
  );

  if (options.wrapConditional && ts.isConditionalExpression(expression)) {
    return createIfElseCall(expression, factory, context.sourceFile);
  }

  return callExpression;
}
