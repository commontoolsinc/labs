import ts from "typescript";

import {
  classifyArrayCallbackContainerCall,
  detectCallKind,
  getPatternBuilderCallbackArgument,
  getPatternToolCallbackArgument,
} from "../ast/call-kind.ts";
import { isEventHandlerJsxAttribute } from "../ast/event-handlers.ts";

export interface CallbackBoundaryLookup {
  isArrayMethodCallback(node: ts.Node): boolean;
}

export type SupportedCallbackBoundaryKind =
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

export type UnsupportedCallbackBoundaryKind =
  | "plain-array-void"
  | "unsupported-container";

type CallbackBoundaryBodyContext =
  | { strategy: "inherit-parent" }
  | {
    strategy: "explicit";
    kind: "pattern" | "compute";
    owner:
      | "pattern"
      | "render"
      | "array-method"
      | "computed"
      | "derive"
      | "action"
      | "lift"
      | "handler"
      | "unknown";
  };

export type CallbackBoundaryDecision =
  | { kind: "none" }
  | {
    kind: "supported";
    boundaryKind: SupportedCallbackBoundaryKind;
    bodyContext: CallbackBoundaryBodyContext;
  }
  | {
    kind: "unsupported";
    boundaryKind: UnsupportedCallbackBoundaryKind;
    bodyContext: CallbackBoundaryBodyContext;
    boundaryDiagnostic: "callback-container" | "function-creation";
  };

export interface CallbackBoundarySemantics {
  readonly decision: CallbackBoundaryDecision;
  readonly bodyContext: CallbackBoundaryBodyContext | undefined;
  readonly isReactiveArrayMethodCallback: boolean;
  readonly isPlainArrayValueCallback: boolean;
  readonly isPatternToolCallback: boolean;
  readonly supportsPatternOwnedWrapperCallbackSite: boolean;
  readonly supportsPatternOwnedStatements: boolean;
  readonly allowsRestrictedContextFunctionCallback: boolean;
  readonly establishesLocalReactiveAliasScope: boolean;
}

function isWithinJsxExpression(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxExpression(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function classifyCallbackBoundary(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  lookup?: CallbackBoundaryLookup,
): CallbackBoundaryDecision {
  const jsxParent = callback.parent;
  if (
    ts.isJsxExpression(jsxParent) &&
    ts.isJsxAttribute(jsxParent.parent) &&
    isEventHandlerJsxAttribute(jsxParent.parent, checker)
  ) {
    return {
      kind: "supported",
      boundaryKind: "event-handler",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "handler",
      },
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
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "array-method",
      },
    };
  }

  const callKind = detectCallKind(parent, checker);
  if (callKind?.kind === "derive") {
    return {
      kind: "supported",
      boundaryKind: "derive",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "derive",
      },
    };
  }

  if (callKind?.kind === "pattern-tool") {
    return {
      kind: "supported",
      boundaryKind: "pattern-tool",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    };
  }

  if (callKind?.kind === "builder") {
    switch (callKind.builderName) {
      case "pattern":
        return {
          kind: "supported",
          boundaryKind: "pattern-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "pattern",
            owner: "pattern",
          },
        };
      case "render":
        return {
          kind: "supported",
          boundaryKind: "render-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "pattern",
            owner: "render",
          },
        };
      case "computed":
        return {
          kind: "supported",
          boundaryKind: "computed-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "computed",
          },
        };
      case "action":
        return {
          kind: "supported",
          boundaryKind: "action-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "action",
          },
        };
      case "lift":
        return {
          kind: "supported",
          boundaryKind: "lift-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "lift",
          },
        };
      case "handler":
        return {
          kind: "supported",
          boundaryKind: "handler-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "handler",
          },
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
        boundaryKind: "reactive-array-method",
        bodyContext: { strategy: "inherit-parent" },
      };
    case "plain-array-value":
      return {
        kind: "supported",
        boundaryKind: "plain-array-value",
        bodyContext: { strategy: "inherit-parent" },
      };
    case "plain-array-void":
      return isWithinJsxExpression(callback)
        ? {
          kind: "unsupported",
          boundaryKind: "plain-array-void",
          boundaryDiagnostic: "callback-container",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "unknown",
          },
        }
        : {
          kind: "unsupported",
          boundaryKind: "plain-array-void",
          boundaryDiagnostic: "function-creation",
          bodyContext: { strategy: "inherit-parent" },
        };
  }

  if (getPatternBuilderCallbackArgument(parent, checker) === callback) {
    return {
      kind: "supported",
      boundaryKind: "pattern-builder",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "pattern",
      },
    };
  }

  if (getPatternToolCallbackArgument(parent, checker) === callback) {
    return {
      kind: "supported",
      boundaryKind: "pattern-tool",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    };
  }

  if (isWithinJsxExpression(callback)) {
    return {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "callback-container",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    };
  }

  return {
    kind: "unsupported",
    boundaryKind: "unsupported-container",
    boundaryDiagnostic: "function-creation",
    bodyContext: { strategy: "inherit-parent" },
  };
}

export function getCallbackBoundarySemantics(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  lookup?: CallbackBoundaryLookup,
): CallbackBoundarySemantics {
  const decision = classifyCallbackBoundary(callback, checker, lookup);
  const bodyContext = decision.kind === "none"
    ? undefined
    : decision.bodyContext;
  const supportedKind = decision.kind === "supported"
    ? decision.boundaryKind
    : undefined;

  return {
    decision,
    bodyContext,
    isReactiveArrayMethodCallback: supportedKind === "reactive-array-method",
    isPlainArrayValueCallback: supportedKind === "plain-array-value",
    isPatternToolCallback: supportedKind === "pattern-tool",
    supportsPatternOwnedWrapperCallbackSite: supportedKind ===
        "reactive-array-method" ||
      supportedKind === "pattern-builder" ||
      supportedKind === "render-builder",
    supportsPatternOwnedStatements: supportedKind === "reactive-array-method" ||
      supportedKind === "pattern-builder" ||
      supportedKind === "render-builder",
    allowsRestrictedContextFunctionCallback: !!supportedKind &&
      supportedKind !== "event-handler" &&
      supportedKind !== "pattern-builder" &&
      supportedKind !== "render-builder",
    establishesLocalReactiveAliasScope: supportedKind === "derive" ||
      supportedKind === "computed-builder",
  };
}
