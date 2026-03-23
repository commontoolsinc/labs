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
import {
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
} from "./opaque-ref/emitters/compute-wrap-invariants.ts";
import type {
  ExpressionContainerKind,
  ExpressionSiteHelperBoundaryKind,
  ExpressionSitePolicyInfo,
} from "./expression-site-types.ts";

interface RewriteExpressionSiteParams {
  readonly expression: ts.Expression;
  readonly containerKind: ExpressionContainerKind;
  readonly context: TransformationContext;
  readonly analyze: AnalyzeFn;
  readonly visit: ts.Visitor;
  readonly preferDeriveWrappers?: boolean;
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

export function requiresLegacyJsxControlFlowHandling(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const containsDeferredJsxArrayMethodSubexpression = (
    root: ts.Expression,
  ): boolean => {
    let found = false;

    const visit = (node: ts.Node): void => {
      if (found) return;
      if (node !== root && ts.isFunctionLike(node)) return;

      if (ts.isExpression(node) &&
        isDeferredJsxArrayMethodExpression(node, context, analyze)) {
        found = true;
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(root);
    return found;
  };

  if (ts.isConditionalExpression(expression)) {
    const branches = [expression.whenTrue, expression.whenFalse];
    return branches.some((branch) =>
      !!findPendingComputeWrapCandidate(branch, analyze, context) ||
      (
        !isJsxLocalRewriteContainer(branch) &&
        containsDeferredJsxArrayMethodSubexpression(branch)
      )
    );
  }

  if (isLogicalBinaryExpression(expression)) {
    return !!findPendingComputeWrapCandidate(expression.right, analyze, context) ||
      (
        !isJsxLocalRewriteContainer(expression.right) &&
        containsDeferredJsxArrayMethodSubexpression(expression.right)
      );
  }

  return false;
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

const HELPER_BOUNDARY_KINDS = new Set<ExpressionSiteHelperBoundaryKind>([
  "ifElse",
  "when",
  "unless",
  "builder",
  "derive",
  "pattern-tool",
]);

function getHelperBoundaryKind(
  expression: ts.Expression,
  context: TransformationContext,
): ExpressionSiteHelperBoundaryKind | undefined {
  let current: ts.Node | undefined = expression;

  while (current) {
    if (current !== expression && ts.isFunctionLike(current)) {
      return undefined;
    }

    const parent: ts.Node | undefined = current.parent;
    if (
      parent &&
      ts.isCallExpression(parent) &&
      parent.pos >= 0 &&
      ts.isExpression(current) &&
      parent.arguments.includes(current)
    ) {
      const callKind = detectCallKind(parent, context.checker)?.kind;
      if (
        callKind &&
        HELPER_BOUNDARY_KINDS.has(callKind as ExpressionSiteHelperBoundaryKind)
      ) {
        return callKind as ExpressionSiteHelperBoundaryKind;
      }
    }

    current = parent;
  }

  return undefined;
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

export function getExpressionSitePolicyInfo(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSitePolicyInfo {
  const reactiveContext = classifyReactiveContext(
    expression,
    context.checker,
    context,
  );
  return {
    containerKind,
    reactiveContext,
    hasAuthoredSourceSite: hasAuthoredSourceSite(expression),
    withinEventHandlerJsxAttribute: isWithinEventHandlerJsxAttribute(
      expression,
      context.checker,
    ),
    arrayMethodOwned: isArrayMethodOwnedExpressionSite(expression, context),
    helperBoundaryKind: getHelperBoundaryKind(expression, context),
    syntheticComputeOwned: context.isSyntheticComputeOwnedNode(expression),
    deferredJsxArrayMethod: containerKind === "jsx-expression" &&
      isDeferredJsxArrayMethodExpression(expression, context, analyze),
    controlFlowRewriteRoot: isControlFlowRewriteExpression(expression),
  };
}

function canRewriteExpressionSite(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const siteInfo = getExpressionSitePolicyInfo(
    expression,
    containerKind,
    context,
    analyze,
  );
  if (!siteInfo.hasAuthoredSourceSite) {
    return false;
  }

  if (siteInfo.withinEventHandlerJsxAttribute) {
    return false;
  }

  if (siteInfo.reactiveContext.kind !== "pattern") {
    return false;
  }

  if (siteInfo.deferredJsxArrayMethod) {
    return false;
  }

  if (containerKind === "jsx-expression" && siteInfo.arrayMethodOwned) {
    return false;
  }

  if (
    containerKind === "jsx-expression" &&
    siteInfo.controlFlowRewriteRoot &&
    requiresLegacyJsxControlFlowHandling(expression, context, analyze)
  ) {
    return false;
  }

  if (containerKind !== "jsx-expression" && !siteInfo.controlFlowRewriteRoot) {
    return false;
  }

  const analysis = analyze(expression);
  return analysis.requiresRewrite ||
    isLogicalBinaryExpression(expression) ||
    (
      containerKind === "jsx-expression" &&
      siteInfo.controlFlowRewriteRoot &&
      analysis.containsOpaqueRef
    );
}

function canDeferExpressionSiteToHelperBoundary(
  siteInfo: ExpressionSitePolicyInfo,
  analysis: ReturnType<AnalyzeFn>,
): boolean {
  if (!siteInfo.helperBoundaryKind) {
    return false;
  }

  if (!siteInfo.hasAuthoredSourceSite || siteInfo.withinEventHandlerJsxAttribute) {
    return false;
  }

  if (siteInfo.syntheticComputeOwned) {
    return false;
  }

  if (siteInfo.reactiveContext.kind !== "pattern") {
    return false;
  }

  if (siteInfo.deferredJsxArrayMethod) {
    return false;
  }

  return analysis.containsOpaqueRef && analysis.requiresRewrite;
}

function canRewriteHelperOwnedExpressionSite(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  if (containerKind === "jsx-expression") {
    return false;
  }

  const siteInfo = getExpressionSitePolicyInfo(
    expression,
    containerKind,
    context,
    analyze,
  );
  if (!siteInfo.helperBoundaryKind) {
    return false;
  }

  if (!siteInfo.hasAuthoredSourceSite || siteInfo.withinEventHandlerJsxAttribute) {
    return false;
  }

  if (siteInfo.syntheticComputeOwned || siteInfo.deferredJsxArrayMethod) {
    return false;
  }

  if (siteInfo.reactiveContext.kind !== "pattern") {
    return false;
  }

  if (
    !ts.isBinaryExpression(expression) &&
    !ts.isPrefixUnaryExpression(expression) &&
    !ts.isPostfixUnaryExpression(expression) &&
    !ts.isConditionalExpression(expression)
  ) {
    return false;
  }

  const analysis = analyze(expression);
  return analysis.containsOpaqueRef && analysis.requiresRewrite;
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
      if (containerKind) {
        const siteInfo = getExpressionSitePolicyInfo(
          current,
          containerKind,
          context,
          analyze,
        );
        const analysis = analyze(current);
        if (
          canRewriteExpressionSite(current, containerKind, context, analyze) ||
          canDeferExpressionSiteToHelperBoundary(siteInfo, analysis)
        ) {
          return {
            expression: current,
            containerKind,
          };
        }
      }
    }

    current = current.parent;
  }

  return undefined;
}

export function rewriteExpressionSite(
  params: RewriteExpressionSiteParams,
): ts.Expression | undefined {
  const {
    expression,
    containerKind,
    context,
    analyze,
    visit,
    preferDeriveWrappers = false,
  } = params;

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
  const controlFlowNeedsRewrite = containerKind === "jsx-expression" &&
    isControlFlowRewriteExpression(expression) &&
    analysis.containsOpaqueRef;

  if (!analysis.requiresRewrite && !hasLogicalOps && !controlFlowNeedsRewrite) {
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
    preferDeriveWrappers,
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

export function rewriteHelperOwnedExpressionSites<T extends ts.Node>(
  root: T,
  context: TransformationContext,
): T {
  const analyze = createDataFlowAnalyzer(context.checker);

  const visit: ts.Visitor = (node) => {
    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (ts.isExpression(visited)) {
      const containerKind = getExpressionContainerKind(visited);
      if (
        containerKind &&
        canRewriteHelperOwnedExpressionSite(
          visited,
          containerKind,
          context,
          analyze,
        )
      ) {
        const analysis = analyze(visited);
        const result = rewriteExpression({
          expression: visited,
          analysis,
          context,
          analyze,
          reactiveContextKind: "pattern",
          inSafeContext: false,
          containerKind,
        });
        if (result) {
          return result;
        }
      }
    }

    return visited;
  };

  return ts.visitNode(root, visit) as T;
}

export function rewritePatternOwnedExpressionSites<T extends ts.Node>(
  root: T,
  context: TransformationContext,
): T {
  const analyze = createDataFlowAnalyzer(context.checker);

  const visit: ts.Visitor = (node) => {
    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const siteInfo = getExpressionSitePolicyInfo(
        node.expression,
        "jsx-expression",
        context,
        analyze,
      );

      if (!siteInfo.controlFlowRewriteRoot) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const rewritten = rewriteExpressionSite({
        expression: node.expression,
        containerKind: "jsx-expression",
        context,
        analyze,
        visit,
        preferDeriveWrappers: true,
      });
      if (rewritten) {
        return context.factory.createJsxExpression(
          node.dotDotDotToken,
          rewritten,
        );
      }

      return visitEachChildWithJsx(node, visit, context.tsContext);
    }

    if (ts.isExpression(node)) {
      const containerKind = getExpressionContainerKind(node);
      if (containerKind) {
        if (containerKind === "jsx-expression") {
          return visitEachChildWithJsx(node, visit, context.tsContext);
        }

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

  return ts.visitNode(root, visit) as T;
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
