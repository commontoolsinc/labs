import ts from "typescript";

import {
  detectCallKind,
  type NormalizedDataFlow,
  setParentPointers,
} from "../../ast/mod.ts";
import { TransformationContext } from "../../core/mod.ts";
import { createDeriveCall } from "../builtins/derive.ts";

function getCaptureRootExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isCallExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isNestedFunctionLocalCapture(
  expression: ts.Expression,
  wrappedExpression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const wrappedSourceNode = wrappedExpression.pos >= 0
    ? wrappedExpression
    : ts.getOriginalNode(wrappedExpression);
  const root = getCaptureRootExpression(expression);
  if (!ts.isIdentifier(root)) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(root);
  if (!symbol) {
    return false;
  }

  const declarations = symbol.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    if (
      declaration.pos < wrappedSourceNode.pos ||
      declaration.end > wrappedSourceNode.end
    ) {
      return false;
    }

    let current: ts.Node | undefined = declaration.parent;
    while (current && current !== wrappedSourceNode) {
      if (ts.isFunctionLike(current)) {
        return true;
      }
      current = current.parent;
    }

    return false;
  });
}

export function createReactiveWrapperForExpression(
  expression: ts.Expression,
  relevantDataFlows: readonly NormalizedDataFlow[],
  context: TransformationContext,
  options: {
    allowDirectExpressionWrap?: boolean;
    preferDeriveWrapper?: boolean;
    filterNestedFunctionLocalCaptures?: boolean;
  } = {},
): ts.Expression | undefined {
  const shouldFilterNestedLocals = options.filterNestedFunctionLocalCaptures ??
    !ts.isCallExpression(expression);

  const wrapperDataFlows = shouldFilterNestedLocals
    ? relevantDataFlows.filter((dataFlow) =>
      !isNestedFunctionLocalCapture(
        dataFlow.expression,
        expression,
        context.checker,
      )
    )
    : [...relevantDataFlows];

  if (wrapperDataFlows.length === 0) return undefined;

  // Don't wrap expressions that are already derive, computed, when, or unless calls
  // These are already reactive and wrapping them would create unnecessary nesting
  if (ts.isCallExpression(expression)) {
    const callKind = detectCallKind(expression, context.checker);
    if (
      callKind?.kind === "derive" ||
      callKind?.kind === "when" ||
      callKind?.kind === "unless" ||
      (callKind?.kind === "builder" && callKind.builderName === "computed")
    ) {
      return undefined;
    }
  }

  if (
    !options.allowDirectExpressionWrap &&
    wrapperDataFlows.length === 1
  ) {
    const [dataFlow] = wrapperDataFlows;
    if (dataFlow && dataFlow.expression === expression) {
      return undefined;
    }
  }

  if (options.preferDeriveWrapper) {
    const refs = wrapperDataFlows.map((dataFlow) => dataFlow.expression);
    return createDeriveCall(expression, refs, {
      factory: context.factory,
      tsContext: context.tsContext,
      cfHelpers: context.cfHelpers,
      context,
    });
  }

  const { factory, checker, sourceFile } = context;

  context.markSyntheticComputeOwnedSubtree(expression);

  // Get result type for the computed call
  let resultTypeNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;

  try {
    resultType = checker.getTypeAtLocation(expression);
    resultTypeNode = checker.typeToTypeNode(
      resultType,
      sourceFile,
      ts.NodeBuilderFlags.NoTruncation |
        ts.NodeBuilderFlags.UseStructuralFallback,
    );
  } catch {
    resultTypeNode = undefined;
    resultType = undefined;
  }

  // Create computed(() => expression)
  const arrowFunction = factory.createArrowFunction(
    undefined,
    undefined,
    [],
    resultTypeNode,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    expression,
  );
  context.markAsSyntheticComputeCallback(arrowFunction);

  const computedCall = context.cfHelpers.createHelperCall(
    "computed",
    expression,
    undefined,
    [arrowFunction],
  );

  // Register types for both the TypeNode and the computed CallExpression
  if (resultTypeNode && resultType && context.options.typeRegistry) {
    context.options.typeRegistry.set(resultTypeNode, resultType);
    context.options.typeRegistry.set(computedCall, resultType);
  }

  // CRITICAL: Set parent pointers and connect to parent chain
  // This maintains the parent chain so walking up from nested callbacks works
  setParentPointers(computedCall, expression.parent);

  return computedCall;
}
