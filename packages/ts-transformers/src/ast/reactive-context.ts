import ts from "typescript";
import { detectCallKind } from "./call-kind.ts";

export type ReactiveContextKind = "pattern" | "compute" | "neutral";

export type ReactiveContextOwner =
  | "pattern"
  | "render"
  | "array-map"
  | "jsx-callback"
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
  isMapCallback(node: ts.Node): boolean;
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

function isInlineJsxEventHandler(
  func: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const parent = func.parent;
  if (!ts.isJsxExpression(parent)) return false;
  const jsxExprParent = parent.parent;
  if (!ts.isJsxAttribute(jsxExprParent)) return false;
  return jsxExprParent.name.getText().startsWith("on");
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

function isNamedCallbackCall(
  call: ts.CallExpression,
  name: string,
): boolean {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    return expression.text === name;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === name;
  }
  return false;
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
  const anchor = resolveContextAnchor(node);
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
      // Transformed mapWithPattern callbacks are explicitly tracked and should
      // always be treated as pattern callbacks, regardless of symbol lookup.
      if (lookup?.isMapCallback(current)) {
        return { kind: "pattern", owner: "array-map", inJsxExpression };
      }

      if (isInlineJsxEventHandler(current)) {
        return { kind: "compute", owner: "handler", inJsxExpression };
      }

      if (isStandaloneFunctionDefinition(current)) {
        return { kind: "compute", owner: "standalone", inJsxExpression };
      }

      const callParent: ts.Node | undefined = current.parent;
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
          // Unknown builder callback: inherit parent context.
        }

        if (callKind?.kind === "pattern-tool") {
          return { kind: "compute", owner: "unknown", inJsxExpression };
        }

        if (callKind?.kind === "array-map") {
          // Non-transformed map callbacks inherit the parent context.
          current = current.parent;
          continue;
        }

        // Fallback for synthetic helper calls where symbol-based call-kind
        // classification can fail transiently during transformation.
        if (
          isNamedCallbackCall(callParent, "pattern") ||
          isNamedCallbackCall(callParent, "patternTool")
        ) {
          return { kind: "pattern", owner: "pattern", inJsxExpression };
        }

        // Unknown callbacks inside JSX expressions should run in compute context.
        // This ensures chains like `list.map(...).filter(...)` are treated as
        // compute callbacks rather than pattern callbacks.
        if (inJsxExpression || isWithinJsxExpression(current)) {
          return { kind: "compute", owner: "jsx-callback", inJsxExpression };
        }
      }
    }

    current = current.parent;
  }

  return {
    kind: "neutral",
    owner: "unknown",
    inJsxExpression,
  };
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
