import ts from "typescript";
import {
  classifyArrayCallbackContainerCall,
  detectCallKind,
  isEventHandlerJsxAttribute,
} from "../ast/mod.ts";
import type { ReactiveContextLookup } from "../ast/reactive-context.ts";

export type SupportedCallbackKind =
  | "event-handler"
  | "reactive-array-method"
  | "plain-array-value"
  | "pattern-builder"
  | "render-builder"
  | "derive"
  | "pattern-tool"
  | "computed-builder"
  | "action-builder"
  | "lift-builder"
  | "handler-builder";

export type UnsupportedCallbackKind =
  | "plain-array-void"
  | "unsupported-container";

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
  lookup?: Pick<ReactiveContextLookup, "isArrayMethodCallback">,
): CallbackSupportDecision {
  const jsxParent = callback.parent;
  if (
    ts.isJsxExpression(jsxParent) &&
    ts.isJsxAttribute(jsxParent.parent) &&
    isEventHandlerJsxAttribute(jsxParent.parent, checker)
  ) {
    return {
      kind: "supported",
      supportedKind: "event-handler",
    };
  }

  const parent = callback.parent;
  if (
    !parent || !ts.isCallExpression(parent) ||
    !parent.arguments.includes(callback)
  ) {
    return { kind: "none" };
  }

  if (lookup?.isArrayMethodCallback(callback)) {
    return {
      kind: "supported",
      supportedKind: "reactive-array-method",
    };
  }

  const callKind = detectCallKind(parent, checker);
  if (callKind?.kind === "derive") {
    return {
      kind: "supported",
      supportedKind: "derive",
    };
  }

  if (callKind?.kind === "pattern-tool") {
    return {
      kind: "supported",
      supportedKind: "pattern-tool",
    };
  }

  if (callKind?.kind === "builder") {
    switch (callKind.builderName) {
      case "pattern":
        return {
          kind: "supported",
          supportedKind: "pattern-builder",
        };
      case "render":
        return {
          kind: "supported",
          supportedKind: "render-builder",
        };
      case "computed":
        return {
          kind: "supported",
          supportedKind: "computed-builder",
        };
      case "action":
        return {
          kind: "supported",
          supportedKind: "action-builder",
        };
      case "lift":
        return {
          kind: "supported",
          supportedKind: "lift-builder",
        };
      case "handler":
        return {
          kind: "supported",
          supportedKind: "handler-builder",
        };
    }
  }

  const arrayCallbackContainer = classifyArrayCallbackContainerCall(
    parent,
    checker,
  );
  switch (arrayCallbackContainer) {
    case "reactive-array-method":
      return {
        kind: "supported",
        supportedKind: "reactive-array-method",
      };
    case "plain-array-value":
      return {
        kind: "supported",
        supportedKind: "plain-array-value",
      };
    case "plain-array-void":
      return {
        kind: "unsupported",
        unsupportedKind: "plain-array-void",
      };
  }

  return {
    kind: "unsupported",
    unsupportedKind: "unsupported-container",
  };
}
