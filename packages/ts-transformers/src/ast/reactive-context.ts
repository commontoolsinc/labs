import ts from "typescript";
import { detectCallKind } from "./call-kind.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";

export type ReactiveContextKind = "pattern" | "compute" | "neutral";

export type ReactiveContextOwner =
  | "pattern"
  | "render"
  | "array-method"
  | "computed"
  | "derive"
  | "action"
  | "lift"
  | "handler"
  | "standalone"
  | "unknown";

export interface ReactiveContextInfo {
  readonly kind: ReactiveContextKind;
  readonly owner: ReactiveContextOwner;
  readonly inJsxExpression: boolean;
}

export interface ReactiveContextLookup {
  isArrayMethodCallback(node: ts.Node): boolean;
  isSyntheticComputeCallback?(node: ts.Node): boolean;
  isSyntheticComputeOwnedNode?(node: ts.Node): boolean;
}

/**
 * Builder names that establish a pattern context where opaque reading and
 * computation lowering rules apply.
 */
export const RESTRICTED_CONTEXT_BUILDERS = new Set([
  "pattern",
  "render",
]);

/**
 * Builder names that establish compute context.
 */
export const SAFE_WRAPPER_BUILDERS = new Set([
  "computed",
  "action",
  "derive",
  "lift",
  "handler",
]);

export interface CallbackContext {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  call: ts.CallExpression;
}

function resolveContextAnchor(node: ts.Node): ts.Node {
  const original = ts.getOriginalNode(node);
  if (original && original !== node && original.parent) {
    return original;
  }
  return node;
}

function getMarkedSyntheticCallbackContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): ReactiveContextInfo | undefined {
  let current: ts.Node | undefined = node.parent;
  let inJsxExpression = false;

  while (current) {
    if (ts.isJsxExpression(current)) {
      inJsxExpression = true;
    }

    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (lookup?.isArrayMethodCallback(current)) {
        return { kind: "pattern", owner: "array-method", inJsxExpression };
      }

      if (lookup?.isSyntheticComputeCallback?.(current)) {
        const callParent = current.parent;
        if (
          callParent &&
          ts.isCallExpression(callParent) &&
          callParent.arguments.includes(current)
        ) {
          const callKind = detectCallKind(callParent, checker);
          if (callKind?.kind === "derive") {
            return { kind: "compute", owner: "derive", inJsxExpression };
          }
          if (callKind?.kind === "builder") {
            const builderContext = getBuilderContext(callKind.builderName);
            if (builderContext) {
              return { ...builderContext, inJsxExpression };
            }
          }
        }
        return { kind: "compute", owner: "unknown", inJsxExpression };
      }
    }

    current = current.parent;
  }

  return undefined;
}

export function findEnclosingCallbackContext(
  node: ts.Node,
): CallbackContext | undefined {
  let current: ts.Node | undefined = resolveContextAnchor(node).parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent: ts.Node | undefined = current.parent;
      if (parent && ts.isCallExpression(parent)) {
        if (parent.arguments.includes(current as ts.Expression)) {
          return { callback: current, call: parent };
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

export function isStandaloneFunctionDefinition(
  func: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): boolean {
  if (ts.isFunctionDeclaration(func)) {
    return true;
  }

  const parent = func.parent;
  if (ts.isVariableDeclaration(parent)) return true;
  if (ts.isPropertyAssignment(parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments.includes(func)) {
    return false;
  }
  if (ts.isJsxExpression(parent)) return false;
  return false;
}

function getBuilderContext(
  builderName: string,
): { kind: ReactiveContextKind; owner: ReactiveContextOwner } | undefined {
  if (builderName === "pattern") {
    return { kind: "pattern", owner: "pattern" };
  }
  if (builderName === "render") {
    return { kind: "pattern", owner: "render" };
  }
  if (builderName === "computed") {
    return { kind: "compute", owner: "computed" };
  }
  if (builderName === "action") {
    return { kind: "compute", owner: "action" };
  }
  if (builderName === "lift") {
    return { kind: "compute", owner: "lift" };
  }
  if (builderName === "handler") {
    return { kind: "compute", owner: "handler" };
  }
  return undefined;
}

/**
 * Classifies the effective context at a node.
 *
 * Rule: nearest known CT callback boundary wins; unknown callbacks inherit the
 * parent context by continuing the ancestor scan.
 */
export function classifyReactiveContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): ReactiveContextInfo {
  const classifyFromAnchor = (anchor: ts.Node): ReactiveContextInfo => {
    const markedSyntheticContext = getMarkedSyntheticCallbackContext(
      anchor,
      checker,
      lookup,
    );
    if (markedSyntheticContext) {
      return markedSyntheticContext;
    }

    let current: ts.Node | undefined = anchor.parent;
    let inJsxExpression = false;

    while (current) {
      if (ts.isJsxExpression(current)) {
        inJsxExpression = true;
      }

      if (ts.isFunctionDeclaration(current)) {
        if (isStandaloneFunctionDefinition(current)) {
          return { kind: "compute", owner: "standalone", inJsxExpression };
        }
      }

      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        if (isStandaloneFunctionDefinition(current)) {
          return { kind: "compute", owner: "standalone", inJsxExpression };
        }

        const boundarySemantics = getCallbackBoundarySemantics(
          current,
          checker,
          {
            isArrayMethodCallback: (node) =>
              lookup?.isArrayMethodCallback(node) ?? false,
          },
        );
        const bodyContext = boundarySemantics.bodyContext;
        if (bodyContext) {
          if (bodyContext.strategy === "inherit-parent") {
            current = current.parent;
            continue;
          }

          return {
            kind: bodyContext.kind,
            owner: bodyContext.owner,
            inJsxExpression,
          };
        }
      }

      current = current.parent;
    }

    return {
      kind: "neutral",
      owner: "unknown",
      inJsxExpression,
    };
  };

  const currentContext = classifyFromAnchor(node);
  if (
    currentContext.kind === "pattern" &&
    currentContext.owner !== "array-method" &&
    lookup?.isSyntheticComputeOwnedNode?.(node)
  ) {
    return {
      kind: "compute",
      owner: "unknown",
      inJsxExpression: currentContext.inJsxExpression,
    };
  }
  if (currentContext.kind !== "neutral") {
    return currentContext;
  }

  const anchor = resolveContextAnchor(node);
  if (anchor !== node) {
    const anchorContext = classifyFromAnchor(anchor);
    if (
      anchorContext.kind === "pattern" &&
      anchorContext.owner !== "array-method" &&
      lookup?.isSyntheticComputeOwnedNode?.(anchor)
    ) {
      return {
        kind: "compute",
        owner: "unknown",
        inJsxExpression: anchorContext.inJsxExpression,
      };
    }
    return anchorContext;
  }

  return currentContext;
}

export function isInsideSafeCallbackWrapper(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "compute";
}

export function isInsideSafeWrapper(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "compute" || info.inJsxExpression;
}

export function isInsideRestrictedContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "pattern";
}

export function isInRestrictedReactiveContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "pattern" && !info.inJsxExpression;
}
