/**
 * Shared analysis helpers for conditional branches.
 *
 * Closure lowering needs to locate the authored branch expression that encloses
 * a particular subtree so it can coordinate array-method lowering with later
 * branch rewriting passes.
 */
import ts from "typescript";

import { detectCallKind } from "./call-kind.ts";

/**
 * Walk up from `node` and return the enclosing conditional branch expression,
 * if `node` is inside a ternary branch or an authored ifElse/when/unless
 * argument.  Returns undefined if no conditional ancestor is found before
 * hitting a function boundary.
 */
export function findEnclosingConditionalBranch(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  // Use the original (pre-transform) AST so parent pointers survive earlier
  // transformer rewrites (e.g., ComputedTransformer).
  const original = ts.getOriginalNode(node);
  let child: ts.Node = original;
  let current: ts.Node | undefined = original.parent;

  while (current) {
    // Stop at function boundaries.
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      return undefined;
    }

    // Ternary: child is one of the branches (not the condition).
    if (
      ts.isConditionalExpression(current) &&
      (child === current.whenTrue || child === current.whenFalse)
    ) {
      return child as ts.Expression;
    }

    // Authored ifElse/when/unless: child is a branch argument.
    if (ts.isCallExpression(current)) {
      const callKind = detectCallKind(current, checker);
      if (
        callKind?.kind === "ifElse" ||
        callKind?.kind === "when" ||
        callKind?.kind === "unless"
      ) {
        // For ifElse(cond, true, false), branch args are index 1+ .
        // For when(cond, value) / unless(cond, value), branch is index 1.
        const argIndex = current.arguments.indexOf(child as ts.Expression);
        if (argIndex > 0) {
          return child as ts.Expression;
        }
      }
    }

    child = current;
    current = current.parent;
  }

  return undefined;
}
