import ts from "typescript";
import {
  classifyArrayMethodCall,
  classifyArrayMethodResultSinkCall,
  classifyArrayMethodResultSinkReceiverChainCall,
  classifyReactiveContext,
  createDataFlowAnalyzer,
  detectCallKind,
  findEnclosingCallbackContext,
  isEventHandlerJsxAttribute,
  isFunctionLikeExpression,
  isWildcardTraversalCall,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { rewriteExpression } from "./opaque-ref/mod.ts";
import { shouldDeferFallbackMapReceiverRewrite } from "./opaque-ref/fallback-rewrite.ts";
import { classifyOpaquePathTerminalCall } from "./opaque-roots.ts";
import type { AnalyzeFn } from "./opaque-ref/types.ts";
import {
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
} from "./opaque-ref/emitters/compute-wrap-invariants.ts";
import { getKnownComputedKeyExpression } from "../utils/reactive-keys.ts";
import type {
  ExpressionContainerKind,
  ExpressionSiteCallRootKind,
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

export type JsxExpressionSiteRoute =
  | { route: "shared-pre-closure" }
  | { route: "shared-post-closure" }
  | {
    route: "owned-pre-closure";
    owner:
      | "opaque-path-terminal-root"
      | "deferred-jsx-array-method-root"
      | "dynamic-element-access-root"
      | "helper-call-root";
  }
  | {
    route: "legacy-jsx";
    reason:
      | "legacy-control-flow-branch-local"
      | "contains-reactive-array-method-subexpression";
  }
  | {
    route: "skip";
    reason:
      | "no-authored-source-site"
      | "event-handler-jsx-attribute"
      | "non-pattern-context"
      | "array-method-owned"
      | "deferred-jsx-array-method-root"
      | "not-shared-jsx-root-kind";
  };

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

function getControlFlowRewriteExpression(
  expr: ts.Expression,
): ts.Expression | undefined {
  const current = unwrapExpression(expr);
  if (
    ts.isConditionalExpression(current) || isLogicalBinaryExpression(current)
  ) {
    return current;
  }
  return undefined;
}

function isControlFlowRewriteExpression(expr: ts.Expression): boolean {
  return !!getControlFlowRewriteExpression(expr);
}

function isPostClosureWrapperRewriteExpression(
  expr: ts.Expression,
  context: TransformationContext,
): boolean {
  const expression = unwrapExpression(expr);

  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isTemplateExpression(expression)
  ) {
    return true;
  }

  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return !!argument &&
      (
        ts.isLiteralExpression(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument) ||
        !!getKnownComputedKeyExpression(argument, context)
      );
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    return expression.operator === ts.SyntaxKind.ExclamationToken;
  }

  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    ) {
      return false;
    }

    if (operator === ts.SyntaxKind.QuestionQuestionToken) {
      return !shouldDeferFallbackMapReceiverRewrite(
        expression,
        context.checker,
      );
    }

    return true;
  }

  return false;
}

export function isPostClosureJsxWrapperRewriteExpression(
  expr: ts.Expression,
  context: TransformationContext,
): boolean {
  return isPostClosureWrapperRewriteExpression(expr, context);
}

function isLocalValueReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return false;
  }

  const declarations = symbol.getDeclarations() ?? [];
  return declarations.some((declaration) =>
    !declaration.getSourceFile().isDeclarationFile && declaration.pos >= 0
  );
}

function getLeftmostMemberBase(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function classifyCallExpressionRoot(
  expression: ts.CallExpression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSiteCallRootKind {
  if (expression.questionDotToken) {
    return "optional-call";
  }

  if (isWildcardTraversalCall(expression, context.checker)) {
    return "other";
  }

  const callKind = detectCallKind(expression, context.checker);
  switch (callKind?.kind) {
    case "ifElse":
    case "when":
    case "unless":
      return "conditional-helper";
    case "array-method":
      return "array-method";
    case "builder":
    case "derive":
    case "cell-factory":
    case "cell-for":
    case "wish":
    case "generate-text":
    case "generate-object":
    case "pattern-tool":
      return "reactive-origin";
    case "runtime-call":
      return callKind.reactiveOrigin ? "reactive-origin" : "other";
  }

  const callee = expression.expression;
  if (ts.isIdentifier(callee)) {
    return isLocalValueReference(callee, context.checker)
      ? "other"
      : "free-function";
  }

  if (
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
  ) {
    const receiverAnalysis = analyze(callee.expression);
    if (receiverAnalysis.containsOpaqueRef) {
      return "receiver-method";
    }

    const base = getLeftmostMemberBase(callee);
    if (!ts.isIdentifier(base)) {
      return "other";
    }

    return isLocalValueReference(base, context.checker)
      ? "other"
      : "free-function";
  }

  return "other";
}

function isSharedPostClosureCallRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  return ts.isCallExpression(expression) &&
    classifyCallExpressionRoot(expression, context, analyze) ===
      "free-function";
}

function isSharedJsxArrayMethodResultSinkCallRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
  owner: ExpressionSitePolicyInfo["reactiveContext"]["owner"],
): boolean {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  if (owner !== "pattern" && owner !== "render") {
    return false;
  }

  const sinkCall = classifyArrayMethodResultSinkCall(
    expression,
    context.checker,
  );
  if (!sinkCall) {
    return false;
  }
  return sinkCall.sink === "join" &&
    containsReactiveArrayMethodSubexpression(expression, context, analyze);
}

function isSharedJsxArrayMethodResultSinkReceiverChainRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
  owner: ExpressionSitePolicyInfo["reactiveContext"]["owner"],
): boolean {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  if (owner !== "pattern" && owner !== "render") {
    return false;
  }

  const sinkReceiverChain = classifyArrayMethodResultSinkReceiverChainCall(
    expression,
    context.checker,
  );
  if (!sinkReceiverChain) {
    return false;
  }

  return sinkReceiverChain.sinkCall.sink === "join" &&
    containsReactiveArrayMethodSubexpression(expression, context, analyze);
}

function isDirectDeriveCall(
  expression: ts.Expression,
  context: TransformationContext,
): expression is ts.CallExpression {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  return detectCallKind(expression, context.checker)?.kind === "derive";
}

function isEligiblePatternOwnedWrapperCallbackSite(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const callbackContext = findEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return true;
  }

  if (context.isArrayMethodCallback(callbackContext.callback)) {
    return true;
  }

  const callKind = detectCallKind(callbackContext.call, context.checker);
  if (
    callKind?.kind === "builder" &&
    (callKind.builderName === "pattern" || callKind.builderName === "render")
  ) {
    return true;
  }

  if (callKind?.kind !== "array-method") {
    return false;
  }

  const callExpression = callbackContext.call.expression;
  if (!ts.isPropertyAccessExpression(callExpression)) {
    return false;
  }

  const receiverAnalysis = analyze(callExpression.expression);
  return receiverAnalysis.containsOpaqueRef;
}

function containsReactiveArrayMethodSubexpression(
  root: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== root && ts.isFunctionLike(node)) return;

    if (
      node !== root &&
      ts.isExpression(node) &&
      isDeferredJsxArrayMethodExpression(node, context, analyze)
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

function isAtomicWholeBranchIife(
  branch: ts.Expression,
): boolean {
  const current = unwrapExpression(branch);
  if (!ts.isCallExpression(current) || current.questionDotToken) {
    return false;
  }

  const callee = unwrapExpression(current.expression);
  if (!ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) {
    return false;
  }

  if (!ts.isBlock(callee.body)) {
    return false;
  }

  const statements = callee.body.statements;
  if (statements.length === 0) {
    return false;
  }

  const lastStatement = statements[statements.length - 1];
  if (
    !lastStatement ||
    !ts.isReturnStatement(lastStatement) ||
    !lastStatement.expression ||
    !isJsxLocalRewriteContainer(lastStatement.expression)
  ) {
    return false;
  }

  return statements.slice(0, -1).every((statement) =>
    ts.isVariableStatement(statement)
  );
}

function isSharedPreClosureAtomicControlFlowExpression(
  expression: ts.Expression,
): boolean {
  const current = getControlFlowRewriteExpression(expression);
  if (!current) {
    return false;
  }

  if (ts.isConditionalExpression(current)) {
    return isAtomicWholeBranchIife(current.whenTrue) ||
      isAtomicWholeBranchIife(current.whenFalse);
  }

  return false;
}

function requiresLegacyJsxControlFlowHandling(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const branchRequiresLegacyHandling = (
    branch: ts.Expression,
    allowWholeBranchValueWrap: boolean,
  ): boolean => {
    const currentBranch = unwrapExpression(branch);

    if (isJsxLocalRewriteContainer(branch)) {
      return false;
    }

    if (isControlFlowRewriteExpression(branch)) {
      const branchRoute = classifyJsxExpressionSiteRoute(
        branch,
        context,
        analyze,
      );
      if (branchRoute.route !== "skip") {
        return branchRoute.route === "legacy-jsx";
      }
    }

    if (
      ts.isCallExpression(currentBranch) &&
      classifyOpaquePathTerminalCall(currentBranch)
    ) {
      return false;
    }

    if (containsReactiveArrayMethodSubexpression(branch, context, analyze)) {
      return true;
    }

    if (isPostClosureWrapperRewriteExpression(branch, context)) {
      return false;
    }

    if (
      allowWholeBranchValueWrap &&
      !ts.isCallExpression(currentBranch)
    ) {
      return false;
    }

    return !!findPendingComputeWrapCandidate(branch, analyze, context);
  };

  const current = getControlFlowRewriteExpression(expression);
  if (!current) {
    return false;
  }

  if (ts.isConditionalExpression(current)) {
    const branches = [current.whenTrue, current.whenFalse];
    return branches.some((branch) =>
      branchRequiresLegacyHandling(branch, true)
    );
  }

  if (isLogicalBinaryExpression(current)) {
    return branchRequiresLegacyHandling(current.right, false);
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

  const arrayMethodInfo = classifyArrayMethodCall(current);
  if (arrayMethodInfo && !arrayMethodInfo.lowered) {
    if (current.arguments.some(isFunctionLikeExpression)) {
      return true;
    }

    if (
      !ts.isPropertyAccessExpression(current.expression) &&
      !ts.isElementAccessExpression(current.expression)
    ) {
      return false;
    }

    const receiverAnalysis = analyze(current.expression.expression);
    if (receiverAnalysis.containsOpaqueRef) {
      return true;
    }
  }

  return detectCallKind(current, context.checker)?.kind === "array-method";
}

function isOwnedDeferredJsxArrayMethodRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) {
    return false;
  }

  if (!isDeferredJsxArrayMethodExpression(current, context, analyze)) {
    return false;
  }

  const callee = current.expression;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }

  const receiverAnalysis = analyze(callee.expression);
  return receiverAnalysis.containsOpaqueRef;
}

function isDirectArrayMethodRootExpression(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  return ts.isCallExpression(current) && !!classifyArrayMethodCall(current);
}

function isOwnedDynamicElementAccessRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  if (!ts.isElementAccessExpression(current)) {
    return false;
  }

  const argument = current.argumentExpression;
  if (!argument) {
    return false;
  }

  if (
    ts.isLiteralExpression(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument) ||
    getKnownComputedKeyExpression(argument, context)
  ) {
    return false;
  }

  return analyze(current).containsOpaqueRef;
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
    callRootKind: ts.isCallExpression(expression)
      ? classifyCallExpressionRoot(expression, context, analyze)
      : undefined,
    syntheticComputeOwned: context.isSyntheticComputeOwnedNode(expression),
    deferredJsxArrayMethod: containerKind === "jsx-expression" &&
      isDeferredJsxArrayMethodExpression(expression, context, analyze),
    controlFlowRewriteRoot: isControlFlowRewriteExpression(expression),
  };
}

export function classifyJsxExpressionSiteRoute(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
  options?: {
    allowDeferredRootOwner?: boolean;
  },
): JsxExpressionSiteRoute {
  const allowDeferredRootOwner = options?.allowDeferredRootOwner ?? false;
  const siteInfo = getExpressionSitePolicyInfo(
    expression,
    "jsx-expression",
    context,
    analyze,
  );

  if (!siteInfo.hasAuthoredSourceSite) {
    return { route: "skip", reason: "no-authored-source-site" };
  }

  if (siteInfo.withinEventHandlerJsxAttribute) {
    return { route: "skip", reason: "event-handler-jsx-attribute" };
  }

  if (siteInfo.reactiveContext.kind !== "pattern") {
    return { route: "skip", reason: "non-pattern-context" };
  }

  if (siteInfo.arrayMethodOwned) {
    return {
      route: "skip",
      reason: "array-method-owned",
    };
  }

  if (siteInfo.deferredJsxArrayMethod) {
    if (
      allowDeferredRootOwner &&
      isOwnedDeferredJsxArrayMethodRoot(expression, context, analyze)
    ) {
      return {
        route: "owned-pre-closure",
        owner: "deferred-jsx-array-method-root",
      };
    }

    return {
      route: "skip",
      reason: "deferred-jsx-array-method-root",
    };
  }

  if (isOwnedDynamicElementAccessRoot(expression, context, analyze)) {
    return {
      route: "owned-pre-closure",
      owner: "dynamic-element-access-root",
    };
  }

  if (siteInfo.callRootKind === "conditional-helper") {
    return {
      route: "owned-pre-closure",
      owner: "helper-call-root",
    };
  }

  if (siteInfo.controlFlowRewriteRoot) {
    if (isSharedPreClosureAtomicControlFlowExpression(expression)) {
      return { route: "shared-pre-closure" };
    }

    return requiresLegacyJsxControlFlowHandling(expression, context, analyze)
      ? { route: "legacy-jsx", reason: "legacy-control-flow-branch-local" }
      : { route: "shared-post-closure" };
  }

  if (siteInfo.callRootKind === "free-function") {
    return { route: "shared-post-closure" };
  }

  if (siteInfo.callRootKind === "receiver-method") {
    if (
      ts.isCallExpression(expression) &&
      classifyOpaquePathTerminalCall(expression)
    ) {
      return {
        route: "owned-pre-closure",
        owner: "opaque-path-terminal-root",
      };
    }

    if (
      isSharedJsxArrayMethodResultSinkCallRoot(
        expression,
        context,
        analyze,
        siteInfo.reactiveContext.owner,
      )
    ) {
      return { route: "shared-post-closure" };
    }

    if (
      isSharedJsxArrayMethodResultSinkReceiverChainRoot(
        expression,
        context,
        analyze,
        siteInfo.reactiveContext.owner,
      )
    ) {
      return { route: "shared-post-closure" };
    }

    return containsReactiveArrayMethodSubexpression(
        expression,
        context,
        analyze,
      )
      ? {
        route: "legacy-jsx",
        reason: "contains-reactive-array-method-subexpression",
      }
      : { route: "shared-post-closure" };
  }

  if (!isPostClosureJsxWrapperRewriteExpression(expression, context)) {
    return { route: "skip", reason: "not-shared-jsx-root-kind" };
  }

  if (containsReactiveArrayMethodSubexpression(expression, context, analyze)) {
    return (
        siteInfo.reactiveContext.owner === "pattern" ||
        siteInfo.reactiveContext.owner === "render"
      )
      ? { route: "shared-post-closure" }
      : {
        route: "legacy-jsx",
        reason: "contains-reactive-array-method-subexpression",
      };
  }

  return { route: "shared-post-closure" };
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
    siteInfo.controlFlowRewriteRoot
  ) {
    const route = classifyJsxExpressionSiteRoute(expression, context, analyze)
      .route;
    if (route !== "shared-post-closure" && route !== "shared-pre-closure") {
      return false;
    }
  }

  if (
    containerKind !== "jsx-expression" &&
    !siteInfo.controlFlowRewriteRoot &&
    siteInfo.arrayMethodOwned
  ) {
    return false;
  }

  if (
    containerKind !== "jsx-expression" &&
    !siteInfo.controlFlowRewriteRoot &&
    !isSharedPostClosureCallRoot(expression, context, analyze) &&
    !isPostClosureWrapperRewriteExpression(expression, context)
  ) {
    return false;
  }

  if (
    containerKind !== "jsx-expression" &&
    !siteInfo.controlFlowRewriteRoot &&
    !isSharedPostClosureCallRoot(expression, context, analyze) &&
    !isEligiblePatternOwnedWrapperCallbackSite(expression, context, analyze)
  ) {
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

  if (
    !siteInfo.hasAuthoredSourceSite || siteInfo.withinEventHandlerJsxAttribute
  ) {
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

  if (
    !siteInfo.hasAuthoredSourceSite || siteInfo.withinEventHandlerJsxAttribute
  ) {
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

function isOptionalAccessExpression(
  expression: ts.Expression,
): expression is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) && !!expression.questionDotToken;
}

function isOptionalCallTarget(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression;
}

function canLowerOptionalAccessExpressionSite(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  if (!isOptionalAccessExpression(expression)) {
    return false;
  }

  if (isOptionalCallTarget(expression)) {
    return false;
  }

  const siteInfo = getExpressionSitePolicyInfo(
    expression,
    containerKind,
    context,
    analyze,
  );

  if (
    !siteInfo.hasAuthoredSourceSite || siteInfo.withinEventHandlerJsxAttribute
  ) {
    return false;
  }

  if (siteInfo.reactiveContext.kind !== "pattern") {
    return false;
  }

  if (containerKind === "jsx-expression") {
    return classifyJsxExpressionSiteRoute(expression, context, analyze)
      .route !==
      "skip";
  }

  if (siteInfo.deferredJsxArrayMethod || siteInfo.arrayMethodOwned) {
    return false;
  }

  return isEligiblePatternOwnedWrapperCallbackSite(
    expression,
    context,
    analyze,
  );
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
          canLowerOptionalAccessExpressionSite(
            current,
            containerKind,
            context,
            analyze,
          ) ||
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

  if (preferDeriveWrappers && isDirectDeriveCall(result, context)) {
    return result;
  }

  return visitEachChildWithJsx(
    result,
    visit,
    context.tsContext,
  ) as ts.Expression;
}

export function rewriteFallbackJsxExpressionSite(
  params: Omit<RewriteExpressionSiteParams, "containerKind">,
): ts.Expression | undefined {
  const {
    expression,
    context,
    analyze,
    visit,
    preferDeriveWrappers = false,
  } = params;

  const contextInfo = classifyReactiveContext(
    expression,
    context.checker,
    context,
  );
  const inSafeContext = contextInfo.kind === "compute";
  const analysis = analyze(expression);
  const hasLogicalOps = containsLogicalBinaryOperator(expression);

  if (inSafeContext) {
    return undefined;
  }

  if (!analysis.requiresRewrite && !hasLogicalOps) {
    return undefined;
  }

  if (context.options.mode === "error") {
    context.reportDiagnostic({
      type: "opaque-ref:jsx-expression",
      message: "JSX expression with OpaqueRef computation should use derive",
      node: expression,
    });
    return expression;
  }

  const result = rewriteExpression({
    expression,
    analysis,
    context,
    analyze,
    reactiveContextKind: contextInfo.kind,
    inSafeContext,
    containerKind: "jsx-expression",
    preferDeriveWrappers,
  });

  if (!result) {
    return undefined;
  }

  if (preferDeriveWrappers && isDirectDeriveCall(result, context)) {
    return result;
  }

  return visitEachChildWithJsx(
    result,
    visit,
    context.tsContext,
  ) as ts.Expression;
}

export function rewriteOpaquePathTerminalJsxExpressionSite(
  params: Omit<RewriteExpressionSiteParams, "containerKind">,
): ts.Expression | undefined {
  const { expression } = params;

  if (
    !ts.isCallExpression(expression) ||
    !classifyOpaquePathTerminalCall(expression)
  ) {
    return undefined;
  }

  return rewriteFallbackJsxExpressionSite(params);
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

      if (
        classifyJsxExpressionSiteRoute(
          node.expression,
          context,
          analyze,
        ).route !== "shared-post-closure"
      ) {
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
          preferDeriveWrappers: true,
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

    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (isDirectArrayMethodRootExpression(node.expression)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const route = classifyJsxExpressionSiteRoute(
        node.expression,
        context,
        analyze,
      );
      if (
        route.route === "skip" &&
        route.reason === "array-method-owned"
      ) {
        const rewritten = rewriteFallbackJsxExpressionSite({
          expression: node.expression,
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
      }

      return visitEachChildWithJsx(node, visit, context.tsContext);
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
