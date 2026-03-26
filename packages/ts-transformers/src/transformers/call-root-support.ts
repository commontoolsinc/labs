import ts from "typescript";
import { getCellKind } from "@commontools/schema-generator/cell-brand";
import type { TransformationContext } from "../core/mod.ts";
import { classifyOpaquePathTerminalCall } from "./opaque-roots.ts";
import type { ExpressionSitePolicyInfo } from "./expression-site-types.ts";

export type SupportedCallRootKind =
  | "helper-owned-explicit-read"
  | "helper-owned-receiver-method"
  | "pattern-owned-receiver-method"
  | "array-method-owned-receiver-method";

function hasOptionalChainedCallee(
  callee: ts.LeftHandSideExpression,
): boolean {
  return (
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
  ) && !!callee.questionDotToken;
}

function hasOpaquePathTerminalReceiverChain(
  callee: ts.LeftHandSideExpression,
): boolean {
  return (
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
  ) &&
    ts.isCallExpression(callee.expression) &&
    !!classifyOpaquePathTerminalCall(callee.expression);
}

export function classifySupportedCallRoot(
  expression: ts.Expression,
  siteInfo: ExpressionSitePolicyInfo,
  context: TransformationContext,
): SupportedCallRootKind | undefined {
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }

  if (classifyOpaquePathTerminalCall(expression) === "get") {
    if (!siteInfo.helperBoundaryKind) {
      return undefined;
    }

    const callee = expression.expression;
    if (!ts.isPropertyAccessExpression(callee)) {
      return undefined;
    }

    try {
      const receiverType = context.checker.getTypeAtLocation(callee.expression);
      const cellKind = getCellKind(receiverType, context.checker);
      return cellKind === "cell" || cellKind === "stream"
        ? "helper-owned-explicit-read"
        : undefined;
    } catch {
      return undefined;
    }
  }

  if (
    siteInfo.reactiveContext.kind !== "pattern" ||
    siteInfo.callRootKind !== "receiver-method"
  ) {
    return undefined;
  }

  if (classifyOpaquePathTerminalCall(expression)) {
    return undefined;
  }

  const callee = expression.expression;
  if (
    hasOptionalChainedCallee(callee) ||
    hasOpaquePathTerminalReceiverChain(callee)
  ) {
    return undefined;
  }

  if (siteInfo.arrayMethodOwned) {
    return siteInfo.helperBoundaryKind
      ? undefined
      : "array-method-owned-receiver-method";
  }

  if (siteInfo.helperBoundaryKind) {
    return siteInfo.reactiveContext.owner === "pattern" ||
        siteInfo.reactiveContext.owner === "render"
      ? "helper-owned-receiver-method"
      : undefined;
  }

  return siteInfo.reactiveContext.owner === "pattern" ||
      siteInfo.reactiveContext.owner === "render"
    ? "pattern-owned-receiver-method"
    : undefined;
}
