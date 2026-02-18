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
 * - Inline JSX event handlers (onClick={() => {...}}) - transformed to handler()
 * - Standalone function definitions (we can't know where they're called from)
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
 * Note: derive is handled separately via callKind.kind === "derive" since it
 * has its own call kind, but is also a safe wrapper.
 */
export const SAFE_WRAPPER_BUILDERS = new Set([
  "computed",
  "action",
  "derive",
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
 * Checks if a function is an inline JSX event handler.
 *
 * An inline JSX event handler is an arrow function or function expression
 * that is the value of a JSX attribute starting with "on" (like onClick, onSubmit, etc.).
 *
 * These get transformed into handler() calls, so they're safe wrappers.
 */
function isInlineJsxEventHandler(
  func: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const parent = func.parent;

  // Check if function is inside a JSX expression
  if (ts.isJsxExpression(parent)) {
    const jsxExprParent = parent.parent;

    // Check if JSX expression is inside a JSX attribute
    if (ts.isJsxAttribute(jsxExprParent)) {
      const attrName = jsxExprParent.name.getText();
      // Event handlers start with "on"
      return attrName.startsWith("on");
    }
  }

  return false;
}

/**
 * Checks if a function is a "standalone" function definition.
 *
 * A standalone function is one that's NOT directly a callback to a builder/map call.
 * Examples:
 * - `function helper() { ... }` - function declaration
 * - `const helper = () => { ... }` - arrow function assigned to variable
 * - `const helper = function() { ... }` - function expression assigned to variable
 *
 * We skip validation inside standalone functions because we can't know where
 * they're called from. If they're only called from safe wrappers (like computed),
 * they're actually safe.
 */
export function isStandaloneFunctionDefinition(
  func: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): boolean {
  // Function declarations are always standalone
  if (ts.isFunctionDeclaration(func)) {
    return true;
  }

  const parent = func.parent;

  // Arrow/function expression assigned to a variable: `const helper = () => { }`
  if (ts.isVariableDeclaration(parent)) {
    return true;
  }

  // Arrow/function expression as property value: `{ helper: () => { } }`
  if (ts.isPropertyAssignment(parent)) {
    return true;
  }

  // If it's a callback to a call expression, it's NOT standalone
  // (it's either a builder callback, map callback, or safe wrapper callback)
  if (ts.isCallExpression(parent) && parent.arguments.includes(func)) {
    return false;
  }

  // If it's in a JSX attribute, it's NOT standalone (it's an inline handler)
  if (ts.isJsxExpression(parent)) {
    return false;
  }

  // Default to not standalone for other cases
  return false;
}

/**
 * Checks if a node is inside a safe callback wrapper where opaque reading is allowed.
 *
 * Safe callback wrappers are:
 * - computed, action, derive, lift, handler callbacks
 * - inline JSX event handlers
 * - standalone function definitions (we can't know where they're called from)
 *
 * NOTE: This does NOT include JSX expressions. Use isInsideSafeWrapper for that.
 * This function is used by the OpaqueRefJSXTransformer which needs to transform
 * JSX expressions (so it shouldn't skip them).
 */
export function isInsideSafeCallbackWrapper(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    // Check for function declarations (always standalone)
    if (ts.isFunctionDeclaration(current)) {
      if (isStandaloneFunctionDefinition(current)) {
        return true;
      }
    }

    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      // Check for inline JSX event handlers (onClick={() => {...}})
      // These get transformed into handler() calls
      if (isInlineJsxEventHandler(current)) {
        return true;
      }

      // Check for standalone function definitions (const helper = () => {...})
      // We skip validation because we can't know where they're called from
      if (isStandaloneFunctionDefinition(current)) {
        return true;
      }

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
 * Checks if a node is inside a safe wrapper callback where opaque reading is allowed.
 *
 * Safe wrappers are:
 * - computed, action, derive, lift, handler callbacks
 * - inline JSX event handlers
 * - standalone function definitions (we can't know where they're called from)
 * - JSX expressions (handled by OpaqueRefJSXTransformer)
 *
 * This is used by validation transformers to avoid reporting errors for code
 * that will be transformed or is in a safe context.
 */
export function isInsideSafeWrapper(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    // Check for JSX expressions - these are handled by OpaqueRefJSXTransformer
    // which rewrites opaque access to use derive()
    if (ts.isJsxExpression(current)) {
      return true;
    }
    current = current.parent;
  }

  // Also check for callback-based safe wrappers
  return isInsideSafeCallbackWrapper(node, checker);
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
