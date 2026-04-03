import ts from "typescript";
import {
  classifyArrayMethodCall,
  classifyArrayMethodCallSite,
  detectCallKind,
  isEventHandlerJsxAttribute,
  isFunctionLikeExpression,
  isInRestrictedReactiveContext,
  type ReactiveContextInfo,
} from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { getKnownComputedKeyExpression } from "../utils/reactive-keys.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";
import {
  type CallRootPolicyDecision,
  classifyCallRootPolicy,
  type ExpressionSiteCallRootKind,
  type ExpressionSiteHelperBoundaryKind,
  type SupportedCallRootKind,
  type UnsupportedCallRootKind,
} from "./call-root-support.ts";
import { shouldDeferFallbackMapReceiverRewrite } from "./expression-rewrite/fallback-array-method-rewrite.ts";
import {
  isJsxLocalRewriteContainer,
} from "./expression-rewrite/emitters/compute-wrap-invariants.ts";
import type { AnalyzeFn } from "./expression-rewrite/types.ts";
import { classifyOpaquePathTerminalCall } from "./opaque-roots.ts";
import type { ExpressionContainerKind } from "./expression-site-types.ts";

interface ExpressionSiteCallRootPolicyInfo {
  readonly reactiveContext: ReactiveContextInfo;
  readonly arrayMethodOwned: boolean;
  readonly helperBoundaryKind?: ExpressionSiteHelperBoundaryKind;
  readonly callRootKind?: ExpressionSiteCallRootKind;
}

interface ExpressionSitePolicyInfo extends ExpressionSiteCallRootPolicyInfo {
  readonly hasAuthoredSourceSite: boolean;
  readonly withinEventHandlerJsxAttribute: boolean;
  readonly syntheticComputeOwned: boolean;
  readonly deferredJsxArrayMethod: boolean;
  readonly controlFlowRewriteRoot: boolean;
}

type JsxExpressionSiteSkipReason =
  | "no-authored-source-site"
  | "event-handler-jsx-attribute"
  | "non-pattern-context"
  | "deferred-jsx-array-method-root"
  | "not-shared-jsx-root-kind";

export type ExpressionSiteHandlingDecision =
  | {
    kind: "shared";
    lowerable: boolean;
    jsxRoute?: "shared-pre-closure" | "shared-post-closure";
  }
  | {
    kind: "owned";
    owner:
      | "helper"
      | "array-method-callback-jsx"
      | "array-method-receiver-method"
      | "jsx-root";
    lowerable: boolean;
  }
  | {
    kind: "skip";
    reason: JsxExpressionSiteSkipReason | "not-lowerable";
  };

export interface ExpressionSiteHandlingOptions {
  readonly allowDeferredRootOwner?: boolean;
}

export interface LowerableExpressionSite {
  readonly expression: ts.Expression;
  readonly containerKind: ExpressionContainerKind;
}

export type RestrictedReactiveComputationDecision =
  | {
    kind: "allowed";
    lowerableSite?: LowerableExpressionSite;
  }
  | {
    kind: "requires-computed";
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

export function isControlFlowRewriteExpression(expr: ts.Expression): boolean {
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

function classifyCallExpressionRoot(
  expression: ts.CallExpression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSiteCallRootKind {
  if (expression.questionDotToken) {
    return "optional-call";
  }

  const callKind = detectCallKind(expression, context.checker);
  switch (callKind?.kind) {
    case "ifElse":
    case "when":
    case "unless":
      return "conditional-helper";
    case "builder":
    case "derive":
    case "cell-factory":
    case "cell-for":
    case "wish":
    case "generate-text":
    case "generate-object":
    case "pattern-tool":
    case "runtime-call":
      return "other";
  }

  const directCallee = unwrapExpression(expression.expression);
  if (
    expression.arguments.length > 0 &&
    (ts.isArrowFunction(directCallee) || ts.isFunctionExpression(directCallee))
  ) {
    return "parameterized-inline-call";
  }

  const callee = expression.expression;
  if (ts.isIdentifier(callee)) {
    return "ordinary-call";
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

    return "ordinary-call";
  }

  return "other";
}

function isSharedJsxLocalHelperCallRoot(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  const callee = expression.expression;
  if (
    !ts.isIdentifier(callee) || !isLocalValueReference(callee, context.checker)
  ) {
    return false;
  }

  return analyze(expression).containsOpaqueRef;
}

function isSharedPostClosureCallRootKind(
  kind: ExpressionSiteCallRootKind | undefined,
): boolean {
  return kind === "ordinary-call" || kind === "parameterized-inline-call";
}

function isEligiblePatternOwnedWrapperCallbackSite(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return true;
  }

  const boundarySemantics = getCallbackBoundarySemantics(
    callbackContext.callback,
    context.checker,
    context,
  );
  return boundarySemantics.supportsPatternOwnedWrapperCallbackSite;
}

function hasEnclosingComputeLikeCallback(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return false;
  }

  let current: ts.Node | undefined = callbackContext.call.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent: ts.Node | undefined = current.parent;
      if (
        parent && ts.isCallExpression(parent) &&
        parent.arguments.includes(current)
      ) {
        const callKind = detectCallKind(parent, context.checker);
        if (callKind?.kind === "derive") {
          return true;
        }
        if (
          callKind?.kind === "builder" &&
          (callKind.builderName === "computed" ||
            callKind.builderName === "action" ||
            callKind.builderName === "lift" ||
            callKind.builderName === "handler")
        ) {
          return true;
        }
      }
    }
    current = current.parent;
  }

  return false;
}

function isWithinComputeLikePlainArrayValueCallback(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return false;
  }

  const boundarySemantics = getCallbackBoundarySemantics(
    callbackContext.callback,
    context.checker,
    context,
  );

  return boundarySemantics.isPlainArrayValueCallback &&
    hasEnclosingComputeLikeCallback(expression, context);
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

function isSharedPreClosureDeferredArrayMethodControlFlowExpression(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): boolean {
  const current = getControlFlowRewriteExpression(expression);
  if (!current || !ts.isConditionalExpression(current)) {
    return false;
  }

  return isOwnedDeferredJsxArrayMethodRoot(
    current.whenTrue,
    context,
    analyze,
  ) ||
    isOwnedDeferredJsxArrayMethodRoot(current.whenFalse, context, analyze);
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
  const contextInfo = context.getReactiveContext(expression);
  if (contextInfo.kind === "pattern" && contextInfo.owner === "array-method") {
    return true;
  }

  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (!callbackContext) {
    return false;
  }

  const boundarySemantics = getCallbackBoundarySemantics(
    callbackContext.callback,
    context.checker,
    context,
  );
  return boundarySemantics.isReactiveArrayMethodCallback;
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

  const arrayMethodCallSite = classifyArrayMethodCallSite(
    current,
    context.checker,
  );
  return !!arrayMethodCallSite &&
    arrayMethodCallSite.ownership === "reactive";
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

export function isDirectArrayMethodRootExpression(
  expression: ts.Expression,
): boolean {
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

function isOwnedObjectLiteralRoot(
  expression: ts.Expression,
  analyze: AnalyzeFn,
): boolean {
  const current = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(current) &&
    analyze(current).containsOpaqueRef;
}

function getExpressionSitePolicyInfo(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSitePolicyInfo {
  const callRootPolicyInfo = getExpressionSiteCallRootPolicyInfo(
    expression,
    context,
    analyze,
  );
  return {
    ...callRootPolicyInfo,
    hasAuthoredSourceSite: hasAuthoredSourceSite(expression),
    withinEventHandlerJsxAttribute: isWithinEventHandlerJsxAttribute(
      expression,
      context.checker,
    ),
    syntheticComputeOwned: context.isSyntheticComputeOwnedNode(expression),
    deferredJsxArrayMethod: containerKind === "jsx-expression" &&
      isDeferredJsxArrayMethodExpression(expression, context, analyze),
    controlFlowRewriteRoot: isControlFlowRewriteExpression(expression),
  };
}

function getExpressionSiteCallRootPolicyInfo(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ExpressionSiteCallRootPolicyInfo {
  return {
    reactiveContext: context.getReactiveContext(expression),
    arrayMethodOwned: isArrayMethodOwnedExpressionSite(expression, context),
    helperBoundaryKind: getHelperBoundaryKind(expression, context),
    callRootKind: ts.isCallExpression(expression)
      ? classifyCallExpressionRoot(expression, context, analyze)
      : undefined,
  };
}

function getSupportedCallRootKind(
  callRootPolicy: CallRootPolicyDecision,
): SupportedCallRootKind | undefined {
  return callRootPolicy.kind === "supported"
    ? callRootPolicy.supportedKind
    : undefined;
}

function isBasePatternExpressionSite(
  siteInfo: ExpressionSitePolicyInfo,
): boolean {
  return siteInfo.hasAuthoredSourceSite &&
    !siteInfo.withinEventHandlerJsxAttribute &&
    siteInfo.reactiveContext.kind === "pattern";
}

function isExpressionSiteLowerable(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  siteInfo: ExpressionSitePolicyInfo,
  analysis: ReturnType<AnalyzeFn>,
): boolean {
  return analysis.requiresRewrite ||
    isOptionalAccessExpression(expression) ||
    isLogicalBinaryExpression(expression) ||
    (
      containerKind === "jsx-expression" &&
      siteInfo.controlFlowRewriteRoot &&
      analysis.containsOpaqueRef
    );
}

function createSharedExpressionSiteDecision(
  lowerable: boolean,
  jsxRoute?: "shared-pre-closure" | "shared-post-closure",
): ExpressionSiteHandlingDecision {
  return jsxRoute
    ? { kind: "shared", jsxRoute, lowerable }
    : { kind: "shared", lowerable };
}

function createOwnedExpressionSiteDecision(
  owner:
    | "helper"
    | "array-method-callback-jsx"
    | "array-method-receiver-method"
    | "jsx-root",
  lowerable: boolean,
): ExpressionSiteHandlingDecision {
  return { kind: "owned", owner, lowerable };
}

function classifyHelperOwnedExpressionSiteHandling(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  siteInfo: ExpressionSitePolicyInfo,
  callRootPolicy: CallRootPolicyDecision,
  analysis: ReturnType<AnalyzeFn>,
): ExpressionSiteHandlingDecision | undefined {
  if (
    containerKind === "jsx-expression" ||
    !siteInfo.helperBoundaryKind ||
    !isBasePatternExpressionSite(siteInfo) ||
    siteInfo.deferredJsxArrayMethod ||
    siteInfo.syntheticComputeOwned
  ) {
    return undefined;
  }

  const supportedCallRootKind = getSupportedCallRootKind(callRootPolicy);
  if (
    !ts.isBinaryExpression(expression) &&
    !ts.isPrefixUnaryExpression(expression) &&
    !ts.isPostfixUnaryExpression(expression) &&
    !ts.isConditionalExpression(expression) &&
    supportedCallRootKind !== "helper-owned-explicit-read" &&
    supportedCallRootKind !== "helper-owned-receiver-method"
  ) {
    return undefined;
  }

  return createOwnedExpressionSiteDecision(
    "helper",
    analysis.containsOpaqueRef && analysis.requiresRewrite,
  );
}

export function classifyExpressionSiteHandling(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: AnalyzeFn,
  options?: ExpressionSiteHandlingOptions,
): ExpressionSiteHandlingDecision {
  if (isWithinComputeLikePlainArrayValueCallback(expression, context)) {
    return { kind: "skip", reason: "not-lowerable" };
  }

  const siteInfo = getExpressionSitePolicyInfo(
    expression,
    containerKind,
    context,
    analyze,
  );
  const callRootPolicy = classifyCallRootPolicy(expression, siteInfo, context);
  const supportedCallRootKind = getSupportedCallRootKind(callRootPolicy);
  let analysis: ReturnType<AnalyzeFn> | undefined;
  const getAnalysis = (): ReturnType<AnalyzeFn> => {
    analysis ??= analyze(expression);
    return analysis;
  };
  const jsxOwnedRootLowerable = (): boolean =>
    getAnalysis().requiresRewrite || isLogicalBinaryExpression(expression);
  const sharedLowerable = (): boolean =>
    isExpressionSiteLowerable(
      expression,
      containerKind,
      siteInfo,
      getAnalysis(),
    );
  const sharedDecision = (
    jsxRoute?: "shared-pre-closure" | "shared-post-closure",
  ): ExpressionSiteHandlingDecision =>
    createSharedExpressionSiteDecision(sharedLowerable(), jsxRoute);
  const ownedDecision = (
    owner:
      | "helper"
      | "array-method-callback-jsx"
      | "array-method-receiver-method"
      | "jsx-root",
    lowerable: boolean,
  ): ExpressionSiteHandlingDecision =>
    createOwnedExpressionSiteDecision(owner, lowerable);

  const helperOwned = classifyHelperOwnedExpressionSiteHandling(
    expression,
    containerKind,
    siteInfo,
    callRootPolicy,
    getAnalysis(),
  );
  if (helperOwned) {
    return helperOwned;
  }
  if (!siteInfo.hasAuthoredSourceSite) {
    return { kind: "skip", reason: "no-authored-source-site" };
  }

  if (siteInfo.withinEventHandlerJsxAttribute) {
    return { kind: "skip", reason: "event-handler-jsx-attribute" };
  }

  if (siteInfo.reactiveContext.kind !== "pattern") {
    return { kind: "skip", reason: "non-pattern-context" };
  }

  if (containerKind === "jsx-expression") {
    if (siteInfo.arrayMethodOwned) {
      return ownedDecision(
        "array-method-callback-jsx",
        jsxOwnedRootLowerable(),
      );
    }

    if (siteInfo.deferredJsxArrayMethod) {
      if (
        options?.allowDeferredRootOwner &&
        isOwnedDeferredJsxArrayMethodRoot(expression, context, analyze)
      ) {
        return ownedDecision("jsx-root", jsxOwnedRootLowerable());
      }

      return {
        kind: "skip",
        reason: "deferred-jsx-array-method-root",
      };
    }

    if (isOwnedDynamicElementAccessRoot(expression, context, analyze)) {
      return ownedDecision("jsx-root", jsxOwnedRootLowerable());
    }

    if (siteInfo.callRootKind === "conditional-helper") {
      return ownedDecision("jsx-root", jsxOwnedRootLowerable());
    }

    if (isOwnedObjectLiteralRoot(expression, analyze)) {
      return createSharedExpressionSiteDecision(
        jsxOwnedRootLowerable(),
        "shared-post-closure",
      );
    }

    if (siteInfo.controlFlowRewriteRoot) {
      return sharedDecision(
        isSharedPreClosureAtomicControlFlowExpression(expression) ||
          isSharedPreClosureDeferredArrayMethodControlFlowExpression(
            expression,
            context,
            analyze,
          )
          ? "shared-pre-closure"
          : "shared-post-closure",
      );
    }

    if (
      isSharedPostClosureCallRootKind(siteInfo.callRootKind) ||
      isSharedJsxLocalHelperCallRoot(expression, context, analyze)
    ) {
      return sharedDecision("shared-post-closure");
    }

    if (siteInfo.callRootKind === "receiver-method") {
      if (
        ts.isCallExpression(expression) &&
        classifyOpaquePathTerminalCall(expression)
      ) {
        return ownedDecision("jsx-root", jsxOwnedRootLowerable());
      }

      return sharedDecision("shared-post-closure");
    }

    if (!isPostClosureWrapperRewriteExpression(expression, context)) {
      return { kind: "skip", reason: "not-shared-jsx-root-kind" };
    }

    return sharedDecision("shared-post-closure");
  }

  if (siteInfo.deferredJsxArrayMethod) {
    return {
      kind: "skip",
      reason: "deferred-jsx-array-method-root",
    };
  }

  if (
    supportedCallRootKind === "array-method-owned-receiver-method"
  ) {
    return ownedDecision(
      "array-method-receiver-method",
      getAnalysis().requiresRewrite,
    );
  }

  if (
    siteInfo.arrayMethodOwned &&
    isSharedPostClosureCallRootKind(siteInfo.callRootKind) &&
    !siteInfo.controlFlowRewriteRoot &&
    containerKind === "return-expression"
  ) {
    return sharedDecision();
  }

  if (siteInfo.arrayMethodOwned && !siteInfo.controlFlowRewriteRoot) {
    return { kind: "skip", reason: "not-lowerable" };
  }

  if (!siteInfo.controlFlowRewriteRoot) {
    const sharedPostClosureCallRoot = isSharedPostClosureCallRootKind(
      siteInfo.callRootKind,
    );
    const patternOwnedReceiverMethod = supportedCallRootKind ===
      "pattern-owned-receiver-method";
    if (!sharedPostClosureCallRoot && !patternOwnedReceiverMethod) {
      if (!isPostClosureWrapperRewriteExpression(expression, context)) {
        return { kind: "skip", reason: "not-lowerable" };
      }

      if (!isEligiblePatternOwnedWrapperCallbackSite(expression, context)) {
        return { kind: "skip", reason: "not-lowerable" };
      }
    }
  }

  return sharedDecision();
}

export function classifyExpressionSiteCallRootPolicy(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): CallRootPolicyDecision {
  return classifyCallRootPolicy(
    expression,
    getExpressionSiteCallRootPolicyInfo(expression, context, analyze),
    context,
  );
}

export function classifyUnsupportedExpressionSiteCallRoot(
  expression: ts.CallExpression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): UnsupportedCallRootKind | undefined {
  if (!isInRestrictedReactiveContext(expression, context.checker, context)) {
    return undefined;
  }

  const decision = classifyExpressionSiteCallRootPolicy(
    expression,
    context,
    analyze,
  );
  return decision.kind === "unsupported" ? decision.unsupportedKind : undefined;
}

function isOptionalAccessExpression(
  expression: ts.Expression,
): expression is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) && !!expression.questionDotToken;
}

export function findLowerableExpressionSite(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): LowerableExpressionSite | undefined {
  let current: ts.Node | undefined = expression;
  let deferredArrayMethodReceiverSite: LowerableExpressionSite | undefined;

  while (current) {
    if (current !== expression && ts.isFunctionLike(current)) {
      return deferredArrayMethodReceiverSite;
    }

    if (ts.isExpression(current)) {
      const containerKind = getExpressionContainerKind(current);
      if (containerKind) {
        if (
          context.getReactiveContext(current).kind !== "pattern"
        ) {
          current = current.parent;
          continue;
        }

        const decision = classifyExpressionSiteHandling(
          current,
          containerKind,
          context,
          analyze,
        );
        if (
          decision.kind !== "skip" &&
          decision.lowerable
        ) {
          const site = {
            expression: current,
            containerKind,
          } as const;
          if (
            decision.kind === "owned" &&
            decision.owner === "array-method-receiver-method"
          ) {
            deferredArrayMethodReceiverSite ??= site;
            current = current.parent;
            continue;
          }
          return {
            expression: site.expression,
            containerKind: site.containerKind,
          };
        }
      }
    }

    current = current.parent;
  }

  return deferredArrayMethodReceiverSite;
}

export function classifyRestrictedReactiveComputation(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): RestrictedReactiveComputationDecision {
  if (!isInRestrictedReactiveContext(expression, context.checker, context)) {
    return { kind: "allowed" };
  }

  const lowerableSite = findLowerableExpressionSite(
    expression,
    context,
    analyze,
  );
  if (lowerableSite) {
    return {
      kind: "allowed",
      lowerableSite,
    };
  }

  const analysis = analyze(expression);
  if (analysis.containsOpaqueRef && analysis.requiresRewrite) {
    return { kind: "requires-computed" };
  }

  return { kind: "allowed" };
}
