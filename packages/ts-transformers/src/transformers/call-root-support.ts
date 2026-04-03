import ts from "typescript";
import { getCellKind } from "@commonfabric/schema-generator/cell-brand";
import type { ReactiveContextInfo } from "../ast/reactive-context.ts";
import type { TransformationContext } from "../core/mod.ts";
import { classifyOpaquePathTerminalCall } from "./opaque-roots.ts";

export type SupportedCallRootKind =
  | "helper-owned-explicit-read"
  | "helper-owned-receiver-method"
  | "pattern-owned-receiver-method"
  | "array-method-owned-receiver-method";

export type UnsupportedCallRootKind =
  | "restricted-get-call"
  | "optional-call"
  | "unsupported-receiver-method";

export type CallRootPolicyDecision =
  | { kind: "supported"; supportedKind: SupportedCallRootKind }
  | { kind: "unsupported"; unsupportedKind: UnsupportedCallRootKind }
  | { kind: "none" };

export type ExpressionSiteHelperBoundaryKind =
  | "ifElse"
  | "when"
  | "unless"
  | "builder"
  | "derive"
  | "pattern-tool";

export type ExpressionSiteCallRootKind =
  | "conditional-helper"
  | "ordinary-call"
  | "parameterized-inline-call"
  | "receiver-method"
  | "optional-call"
  | "other";

type CallRootPolicySiteInfo = {
  readonly reactiveContext: ReactiveContextInfo;
  readonly arrayMethodOwned: boolean;
  readonly helperBoundaryKind?: ExpressionSiteHelperBoundaryKind;
  readonly callRootKind?: ExpressionSiteCallRootKind;
};

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

export function classifyCallRootPolicy(
  expression: ts.Expression,
  siteInfo: CallRootPolicySiteInfo,
  context: TransformationContext,
): CallRootPolicyDecision {
  if (!ts.isCallExpression(expression)) {
    return { kind: "none" };
  }

  if (classifyOpaquePathTerminalCall(expression) === "get") {
    if (siteInfo.helperBoundaryKind) {
      const callee = expression.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        try {
          const receiverType = context.checker.getTypeAtLocation(
            callee.expression,
          );
          const cellKind = getCellKind(receiverType, context.checker);
          if (cellKind === "cell" || cellKind === "stream") {
            return {
              kind: "supported",
              supportedKind: "helper-owned-explicit-read",
            };
          }
        } catch {
          // Fall through to the shared unsupported decision below.
        }
      }
    }

    if (siteInfo.reactiveContext.kind === "pattern") {
      return {
        kind: "unsupported",
        unsupportedKind: "restricted-get-call",
      };
    }

    return { kind: "none" };
  }

  if (
    siteInfo.reactiveContext.kind !== "pattern"
  ) {
    return { kind: "none" };
  }

  if (
    siteInfo.callRootKind === "optional-call" ||
    hasOptionalChainedCallee(expression.expression)
  ) {
    return {
      kind: "unsupported",
      unsupportedKind: "optional-call",
    };
  }

  if (siteInfo.callRootKind !== "receiver-method") {
    return { kind: "none" };
  }

  if (classifyOpaquePathTerminalCall(expression)) {
    return { kind: "none" };
  }

  const callee = expression.expression;
  if (hasOpaquePathTerminalReceiverChain(callee)) {
    return { kind: "none" };
  }

  if (siteInfo.arrayMethodOwned) {
    return siteInfo.helperBoundaryKind
      ? { kind: "unsupported", unsupportedKind: "unsupported-receiver-method" }
      : {
        kind: "supported",
        supportedKind: "array-method-owned-receiver-method",
      };
  }

  if (siteInfo.helperBoundaryKind) {
    return siteInfo.reactiveContext.owner === "pattern" ||
        siteInfo.reactiveContext.owner === "render"
      ? { kind: "supported", supportedKind: "helper-owned-receiver-method" }
      : { kind: "unsupported", unsupportedKind: "unsupported-receiver-method" };
  }

  return siteInfo.reactiveContext.owner === "pattern" ||
      siteInfo.reactiveContext.owner === "render"
    ? { kind: "supported", supportedKind: "pattern-owned-receiver-method" }
    : { kind: "unsupported", unsupportedKind: "unsupported-receiver-method" };
}
