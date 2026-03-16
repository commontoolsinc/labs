/**
 * Shared analysis for conditional branches.
 *
 * Both the ClosureTransformer and CapabilityLoweringTransformer need to reason
 * about whether a conditional branch will be derive-wrapped.  This module
 * provides the shared predicate so the two phases agree on the same criteria.
 *
 * A branch is derive-wrapped by CapabilityLowering when it contains OpaqueRef
 * reads that are NOT already inside a helper rewrite boundary (e.g.,
 * mapWithPattern, derive, computed, ifElse).  This function checks whether
 * such reads exist in a branch, optionally excluding a specific subtree (so
 * the caller can ask "are there OTHER reactive reads besides my own .map()
 * call?").
 */
import ts from "typescript";

import { detectCallKind } from "./call-kind.ts";
import { getTypeAtLocationWithFallback } from "./utils.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";
import type { TransformationContext } from "../core/mod.ts";

/**
 * Check whether a node is a helper rewrite boundary — a call expression that
 * manages its own reactive subscriptions and does not need to be wrapped in
 * a derive.  Mirrors the check in compute-wrap-invariants.ts.
 */
function isHelperBoundary(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isCallExpression(node)) return false;

  const callKind = detectCallKind(node, checker);
  return (
    callKind?.kind === "array-method" ||
    callKind?.kind === "derive" ||
    callKind?.kind === "builder" ||
    callKind?.kind === "ifElse" ||
    callKind?.kind === "when" ||
    callKind?.kind === "unless"
  );
}

/**
 * Returns true if `branch` contains OpaqueRef identifier reads that are not
 * inside a helper boundary, excluding nodes within `excludeSubtree`.
 *
 * This predicts whether CapabilityLowering's `processBranch` /
 * `rewriteHelperOwnedExpression` will wrap the branch in a derive.
 */
export function branchHasNonHelperOpaqueReads(
  branch: ts.Node,
  context: TransformationContext,
  excludeSubtree?: ts.Node,
): boolean {
  const { checker } = context;
  let found = false;

  const walk = (node: ts.Node): void => {
    if (found) return;

    // Skip the subtree the caller wants excluded (e.g., the .map() call
    // whose transformation decision depends on this analysis).
    if (excludeSubtree && node === excludeSubtree) return;

    // Stop at function boundaries — nested functions have their own scopes.
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      return;
    }

    // Stop at helper boundaries — they manage their own reactivity.
    if (isHelperBoundary(node, checker)) return;

    // Check identifiers for OpaqueRef type.  After ComputedTransformer
    // rewrites computed() → derive(), the checker may see the unwrapped
    // return type rather than OpaqueRef.  Check the typeRegistry first
    // (which preserves original types), then fall back to the checker.
    if (ts.isIdentifier(node)) {
      const type = getTypeAtLocationWithFallback(
        node,
        checker,
        context.options.typeRegistry,
        context.options.logger,
      );
      if (type && isOpaqueRefType(type, checker)) {
        found = true;
        return;
      }
      // Also check if this identifier is declared as a computed/derive
      // result — these produce OpaqueRef at runtime even if the checker
      // sees the unwrapped type after ComputedTransformer.
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        for (const decl of symbol.declarations ?? []) {
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            if (ts.isCallExpression(decl.initializer)) {
              const callKind = detectCallKind(decl.initializer, checker);
              if (
                callKind?.kind === "derive" ||
                (callKind?.kind === "builder" &&
                  callKind.builderName === "computed")
              ) {
                found = true;
                return;
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(branch);
  return found;
}

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
