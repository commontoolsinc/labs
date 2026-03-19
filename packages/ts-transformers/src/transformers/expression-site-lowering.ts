import ts from "typescript";
import {
  classifyReactiveContext,
  createDataFlowAnalyzer,
  detectCallKind,
  findEnclosingCallbackContext,
  isEventHandlerJsxAttribute,
  isFunctionLikeExpression,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { rewriteExpression } from "./opaque-ref/mod.ts";
import type { AnalyzeFn } from "./opaque-ref/types.ts";
import type { ExpressionContainerKind } from "./expression-site-types.ts";

interface RewriteExpressionSiteParams {
  readonly expression: ts.Expression;
  readonly containerKind: ExpressionContainerKind;
  readonly context: TransformationContext;
  readonly analyze: AnalyzeFn;
  readonly visit: ts.Visitor;
}

export function containsLogicalBinaryOperator(expr: ts.Expression): boolean {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    ) {
      return true;
    }
  }

  let found = false;
  expr.forEachChild((child) => {
    if (found || ts.isFunctionLike(child)) return;
    if (ts.isExpression(child) && containsLogicalBinaryOperator(child)) {
      found = true;
    }
  });
  return found;
}

function isLogicalBinaryExpression(
  expr: ts.Expression,
): expr is ts.BinaryExpression {
  return ts.isBinaryExpression(expr) &&
    (
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken
    );
}

function isControlFlowRewriteExpression(expr: ts.Expression): boolean {
  return ts.isConditionalExpression(expr) || isLogicalBinaryExpression(expr);
}

export function getExpressionContainerKind(
  expression: ts.Expression,
): ExpressionContainerKind | undefined {
  const parent = expression.parent;
  if (!parent) return undefined;

  if (ts.isJsxExpression(parent) && parent.expression === expression) {
    return "jsx-expression";
  }
  if (
    (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
    parent.body === expression
  ) {
    return "return-expression";
  }
  if (ts.isReturnStatement(parent) && parent.expression === expression) {
    return "return-expression";
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
    return "variable-initializer";
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(expression)) {
    return "call-argument";
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === expression) {
    return "object-property";
  }
  if (
    ts.isArrayLiteralExpression(parent) && parent.elements.includes(expression)
  ) {
    return "array-element";
  }

  return undefined;
}

function hasAuthoredSourceSite(node: ts.Node): boolean {
  const original = ts.getOriginalNode(node);

  if (node.getSourceFile() && node.pos >= 0) {
    return true;
  }

  return original !== node &&
    !!original.getSourceFile() &&
    original.pos >= 0;
}

function isWithinEventHandlerJsxAttribute(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node;

  while (current) {
    if (ts.isJsxAttribute(current)) {
      return isEventHandlerJsxAttribute(current, checker);
    }
    current = current.parent;
  }

  return false;
}

function isArrayMethodOwnedExpressionSite(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const contextInfo = classifyReactiveContext(
    expression,
    context.checker,
    context,
  );
  if (contextInfo.kind === "pattern" && contextInfo.owner === "array-method") {
    return true;
  }

  const callbackContext = findEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return false;
  }

  if (context.isArrayMethodCallback(callbackContext.callback)) {
    return true;
  }

  const callKind = detectCallKind(callbackContext.call, context.checker);
  return callKind?.kind === "array-method";
}

function isDeferredJsxArrayMethodExpression(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) {
    return false;
  }

  if (
    ts.isPropertyAccessExpression(current.expression) &&
    (
      current.expression.name.text === "map" ||
      current.expression.name.text === "filter" ||
      current.expression.name.text === "flatMap"
    )
  ) {
    if (current.arguments.some(isFunctionLikeExpression)) {
      return true;
    }

    const receiverAnalysis = analyze(current.expression.expression);
    if (receiverAnalysis.containsOpaqueRef) {
      return true;
    }
  }

  return detectCallKind(current, context.checker)?.kind === "array-method";
}

function canRewriteExpressionSite(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  if (!hasAuthoredSourceSite(expression)) {
    return false;
  }

  if (isWithinEventHandlerJsxAttribute(expression, context.checker)) {
    return false;
  }

  const contextInfo = classifyReactiveContext(
    expression,
    context.checker,
    context,
  );
  if (contextInfo.kind !== "pattern") {
    return false;
  }

  if (
    containerKind !== "jsx-expression" &&
    !isArrayMethodOwnedExpressionSite(expression, context)
  ) {
    return false;
  }

  if (
    containerKind === "jsx-expression" &&
    isDeferredJsxArrayMethodExpression(expression, context, analyze)
  ) {
    return false;
  }

  if (
    containerKind !== "jsx-expression" &&
    !isControlFlowRewriteExpression(expression)
  ) {
    return false;
  }

  const analysis = analyze(expression);
  return analysis.requiresRewrite || isLogicalBinaryExpression(expression);
}

export function findLowerableExpressionSite(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
):
  | { expression: ts.Expression; containerKind: ExpressionContainerKind }
  | undefined {
  let current: ts.Node | undefined = expression;

  while (current) {
    if (current !== expression && ts.isFunctionLike(current)) {
      return undefined;
    }

    if (ts.isExpression(current)) {
      const containerKind = getExpressionContainerKind(current);
      if (
        containerKind &&
        canRewriteExpressionSite(current, containerKind, context, analyze)
      ) {
        return {
          expression: current,
          containerKind,
        };
      }
    }

    current = current.parent;
  }

  return undefined;
}

export function rewriteExpressionSite(
  params: RewriteExpressionSiteParams,
): ts.Expression | undefined {
  const { expression, containerKind, context, analyze, visit } = params;

  if (!canRewriteExpressionSite(expression, containerKind, context, analyze)) {
    return undefined;
  }

  const contextInfo = classifyReactiveContext(
    expression,
    context.checker,
    context,
  );
  const analysis = analyze(expression);
  const hasLogicalOps = containsLogicalBinaryOperator(expression);

  if (!analysis.requiresRewrite && !hasLogicalOps) {
    return undefined;
  }

  if (context.options.mode === "error") {
    if (containerKind === "jsx-expression") {
      context.reportDiagnostic({
        type: "opaque-ref:jsx-expression",
        message: "JSX expression with OpaqueRef computation should use derive",
        node: expression,
      });
    }
    return expression;
  }

  const result = rewriteExpression({
    expression,
    analysis,
    context,
    analyze,
    reactiveContextKind: contextInfo.kind,
    inSafeContext: contextInfo.kind === "compute",
    containerKind,
  });

  if (!result) {
    return undefined;
  }

  return visitEachChildWithJsx(
    result,
    visit,
    context.tsContext,
  ) as ts.Expression;
}

export function rewriteArrayMethodCallbackExpressionSites(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const analyze = createDataFlowAnalyzer(context.checker);

  const visit: ts.Visitor = (node) => {
    if (
      node !== body &&
      ts.isFunctionLike(node)
    ) {
      return node;
    }

    if (ts.isExpression(node)) {
      const containerKind = node === body
        ? "return-expression"
        : getExpressionContainerKind(node);
      if (containerKind && containerKind !== "jsx-expression") {
        const rewritten = rewriteExpressionSite({
          expression: node,
          containerKind,
          context,
          analyze,
          visit,
        });
        if (rewritten) {
          return rewritten;
        }
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return ts.visitNode(body, visit) as ts.ConciseBody;
}
