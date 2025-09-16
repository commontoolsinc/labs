import ts from "typescript";

import {
  createIfElseCall,
  replaceOpaqueRefsWithParams,
} from "../transforms.ts";
import { getCommonToolsModuleAlias } from "../../core/common-tools.ts";
import type { BindingPlan } from "./bindings.ts";
import type { RewriteContext } from "./types.ts";
import type { NormalisedDependency } from "../normalise.ts";
import type { OpaqueExpressionAnalysis } from "../dependency.ts";
import { isFunctionParameter } from "../types.ts";

function originatesFromIgnoredParameter(
  expression: ts.Expression,
  scopeId: number,
  analysis: OpaqueExpressionAnalysis,
  checker: ts.TypeChecker,
): boolean {
  const scope = analysis.graph.scopes.find((candidate) =>
    candidate.id === scopeId
  );
  if (!scope) return false;

  const isIgnoredSymbol = (symbol: ts.Symbol | undefined): boolean => {
    if (!symbol) return false;
    const symbolName = symbol.getName();
    return scope.parameters.some((parameter) =>
      parameter.symbol === symbol || parameter.name === symbolName
    );
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

export function filterRelevantDependencies(
  dependencies: readonly NormalisedDependency[],
  analysis: OpaqueExpressionAnalysis,
  context: RewriteContext,
): NormalisedDependency[] {
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

  return dependencies.filter((dependency) => {
    if (
      originatesFromIgnoredParameter(
        dependency.expression,
        dependency.scopeId,
        analysis,
        context.checker,
      )
    ) {
      return false;
    }
    if (isParameterExpression(dependency.expression)) return false;
    return true;
  });
}

export function createDeriveIdentifier(
  context: RewriteContext,
): ts.Expression {
  const moduleAlias = getCommonToolsModuleAlias(context.sourceFile);
  if (moduleAlias) {
    return context.factory.createPropertyAccessExpression(
      context.factory.createIdentifier(moduleAlias),
      context.factory.createIdentifier("derive"),
    );
  }
  return context.factory.createIdentifier("derive");
}

export function createDeriveDependencyObject(
  plan: BindingPlan,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const properties = plan.entries.map((entry, index) => {
    const dependency = entry.dependency.expression;
    if (ts.isIdentifier(dependency) && dependency.text === entry.propertyName) {
      return factory.createShorthandPropertyAssignment(dependency, undefined);
    }
    return factory.createPropertyAssignment(
      factory.createIdentifier(entry.propertyName),
      dependency,
    );
  });
  return factory.createObjectLiteralExpression(properties, false);
}

function createLambdaParameter(
  plan: BindingPlan,
  factory: ts.NodeFactory,
): ts.ParameterDeclaration {
  if (!plan.usesObjectBinding) {
    return factory.createParameterDeclaration(
      undefined,
      undefined,
      factory.createIdentifier(plan.entries[0].paramName),
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
    ? [createDeriveDependencyObject(plan, factory), arrowFunction]
    : [plan.entries[0].dependency.expression, arrowFunction];

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
