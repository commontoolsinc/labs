import ts from "typescript";
import {
  type CallbackBoundaryLookup,
  classifyCallbackBoundary,
  type SupportedCallbackBoundaryKind as SupportedCallbackKind,
  type UnsupportedCallbackBoundaryKind as UnsupportedCallbackKind,
} from "../policy/callback-boundary.ts";

export type CallbackSupportDecision =
  | { kind: "supported"; supportedKind: SupportedCallbackKind }
  | { kind: "unsupported"; unsupportedKind: UnsupportedCallbackKind }
  | { kind: "none" };

export function isReactiveArrayMethodCallbackSupport(
  decision: CallbackSupportDecision,
): boolean {
  return decision.kind === "supported" &&
    decision.supportedKind === "reactive-array-method";
}

export function supportsPatternOwnedWrapperCallbackSite(
  decision: CallbackSupportDecision,
): boolean {
  return decision.kind === "supported" &&
    (
      decision.supportedKind === "reactive-array-method" ||
      decision.supportedKind === "pattern-builder" ||
      decision.supportedKind === "render-builder"
    );
}

export function allowsRestrictedContextFunctionCallback(
  decision: CallbackSupportDecision,
): boolean {
  return decision.kind === "supported" &&
    decision.supportedKind !== "event-handler" &&
    decision.supportedKind !== "pattern-builder" &&
    decision.supportedKind !== "render-builder";
}

export function classifyCallbackSupport(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  lookup?: CallbackBoundaryLookup,
): CallbackSupportDecision {
  const boundary = classifyCallbackBoundary(callback, checker, lookup);
  switch (boundary.kind) {
    case "none":
      return { kind: "none" };
    case "supported":
      return {
        kind: "supported",
        supportedKind: boundary.boundaryKind,
      };
    case "unsupported":
      return {
        kind: "unsupported",
        unsupportedKind: boundary.boundaryKind,
      };
  }
}
