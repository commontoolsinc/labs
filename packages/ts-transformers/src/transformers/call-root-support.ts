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
  | "unsupported-receiver-method";

export type CallRootPolicyDecision =
  | { kind: "supported"; supportedKind: SupportedCallRootKind }
  | { kind: "unsupported"; unsupportedKind: UnsupportedCallRootKind }
  | { kind: "none" };

// NOTE (CT-1643): a former `"derive"` member was removed here. It was dead —
// matched against `detectCallKind().kind`, which never returns "derive" (the
// canonical lowered form is `kind: "lift-applied"`; CallKind has no derive kind).
// Whether the lowered lift-applied form SHOULD be treated as a helper boundary
// at expression sites is a separate, open question (see CT-1643 notes); removing
// the dead entry is byte-identical and does not pre-judge that.
export type ExpressionSiteHelperBoundaryKind =
  | "ifElse"
  | "when"
  | "unless"
  | "builder"
  | "pattern-tool";

export type ExpressionSiteCallRootKind =
  | "conditional-helper"
  | "ordinary-call"
  | "parameterized-inline-call"
  | "receiver-method"
  | "other";

type CallRootPolicySiteInfo = {
  readonly reactiveContext: ReactiveContextInfo;
  readonly arrayMethodOwned: boolean;
  readonly helperBoundaryKind?: ExpressionSiteHelperBoundaryKind;
  readonly callRootKind?: ExpressionSiteCallRootKind;
};

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
