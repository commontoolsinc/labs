/**
 * Reactive Context Detection
 *
 * Shared utilities for detecting whether code is in a reactive context
 * where opaque access is restricted vs. a safe wrapper context where
 * opaque access is allowed.
 *
 * ## Context Types
 *
 * **Restricted Reactive Contexts** (opaque reading NOT allowed):
 * - recipe body
 * - pattern body
 * - render body
 * - map/mapWithPattern callbacks on opaques/cells
 *
 * **Safe Wrapper Contexts** (opaque reading IS allowed):
 * - computed() callbacks
 * - action() callbacks
 * - derive() callbacks
 * - lift() callbacks
 * - handler() callbacks
 * - JSX expressions (handled by OpaqueRefJSXTransformer)
 *
 * This module is used by both validation transformers (to report errors)
 * and transformation transformers (to decide when to rewrite).
 */
import ts from "typescript";
import { detectCallKind } from "./call-kind.ts";

/**
 * Builder names that establish a "reactive context" where reading opaques is NOT allowed.
 */
export const RESTRICTED_CONTEXT_BUILDERS = new Set([
  "recipe",
  "pattern",
  "render",
]);

/**
 * Builder names that are "safe wrappers" where reading opaques IS allowed.
 */
export const SAFE_WRAPPER_BUILDERS = new Set([
  "computed",
  "action",
  "lift",
  "handler",
]);

export interface CallbackContext {
  /** The function (arrow or regular) that forms the callback */
  callback: ts.ArrowFunction | ts.FunctionExpression;
  /** The call expression this callback is an argument to */
  call: ts.CallExpression;
}

/**
 * Finds the enclosing callback context for a node.
 * Returns the callback function and the call it's an argument to.
 */
export function findEnclosingCallbackContext(
  node: ts.Node,
): CallbackContext | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    // Check if we're inside an arrow function or function expression
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const functionParent = current.parent;
      if (functionParent && ts.isCallExpression(functionParent)) {
        // Check if this function is an argument to the call
        if (functionParent.arguments.includes(current as ts.Expression)) {
          return {
            callback: current,
            call: functionParent,
          };
        }
      }
    }
    current = current.parent;
  }

  return undefined;
}

/**
 * Checks if a node is inside a safe wrapper callback where opaque reading is allowed.
 *
 * Safe wrappers are: computed, action, derive, lift, handler
 */
export function isInsideSafeWrapper(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const functionParent = current.parent;
      if (
        functionParent &&
        ts.isCallExpression(functionParent) &&
        functionParent.arguments.includes(current as ts.Expression)
      ) {
        const callKind = detectCallKind(functionParent, checker);
        if (callKind) {
          // derive is a safe wrapper
          if (callKind.kind === "derive") {
            return true;
          }
          // Check builder-based safe wrappers
          if (
            callKind.kind === "builder" &&
            SAFE_WRAPPER_BUILDERS.has(callKind.builderName)
          ) {
            return true;
          }
        }
      }
    }
    current = current.parent;
  }

  return false;
}

/**
 * Checks if a node is inside a restricted reactive context where opaque reading is NOT allowed.
 *
 * Restricted contexts are: recipe, pattern, render bodies, and map callbacks on opaques.
 */
export function isInsideRestrictedContext(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const functionParent = current.parent;
      if (
        functionParent &&
        ts.isCallExpression(functionParent) &&
        functionParent.arguments.includes(current as ts.Expression)
      ) {
        const callKind = detectCallKind(functionParent, checker);
        if (callKind) {
          // recipe, pattern, render are restricted
          if (
            callKind.kind === "builder" &&
            RESTRICTED_CONTEXT_BUILDERS.has(callKind.builderName)
          ) {
            return true;
          }
          // array-map on opaques/cells is restricted
          if (callKind.kind === "array-map") {
            return true;
          }
        }
      }
    }
    current = current.parent;
  }

  return false;
}

/**
 * Checks if a node is in a "restricted reactive context" where reading opaques is NOT allowed.
 *
 * This returns true if:
 * - We're inside a recipe/pattern body OR a .map callback on opaques
 * - AND we're NOT inside a safe wrapper (computed, action, derive, lift, handler)
 *
 * @example
 * // Returns true (restricted - opaque reading not allowed):
 * recipe("test", ({ item }) => {
 *   const x = item.price > 100; // <-- here
 * });
 *
 * // Returns false (safe wrapper - opaque reading allowed):
 * recipe("test", ({ item }) => {
 *   const x = computed(() => item.price > 100); // <-- here (inside computed)
 * });
 */
export function isInRestrictedReactiveContext(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  // Only restricted if we're in a restricted context but NOT in a safe wrapper
  // Safe wrappers are checked first (innermost) to ensure they take precedence
  return isInsideRestrictedContext(node, checker) &&
    !isInsideSafeWrapper(node, checker);
}
