import ts from "typescript";

import { outermostTransparentWrapper } from "../utils/expression.ts";

/**
 * A node's position as a direct call argument: the call that lists it, the
 * argument node as listed, and its index in the argument list.
 */
export interface CallArgumentPosition {
  /** The call whose argument list carries the node. */
  readonly call: ts.CallExpression;

  /** The node `call.arguments` lists — the queried node itself, or the
   *  outermost parenthesized wrapper around it. Identity comparisons against
   *  entries of `call.arguments` must use this node, never the queried one. */
  readonly argument: ts.Expression;

  /** Index of `argument` within `call.arguments`. */
  readonly index: number;
}

/**
 * Locates the call that lists `node` as a direct argument, treating
 * parentheses as spelling: `f(((x) => 0))` occupies the same argument
 * position as `f((x) => 0)`, per the paren-invariance the target-language
 * spec holds across site classification (§5.7). Argument-position decisions —
 * membership, index, owning call — go through here so no classifier can tell
 * the two spellings apart. Parentheses only: type-level wrappers (`as`,
 * `satisfies`) change what the checker sees and stay visible to callers.
 *
 * Returns undefined when `node` (transparent wrappers included) is not a direct
 * argument of a call — including when it is the callee, or an argument of a
 * `new` expression.
 */
export function getCallArgumentPosition(
  node: ts.Node,
): CallArgumentPosition | undefined {
  // The argument the call actually holds is the outermost transparent wrapper
  // around `node`, so the walk runs out to the usage site and reports that node
  // rather than the inner one — callers index into `call.arguments` with it.
  const argument: ts.Node = ts.isExpression(node)
    ? outermostTransparentWrapper(node)
    : node;
  const parent: ts.Node | undefined = argument.parent;
  if (!parent || !ts.isCallExpression(parent) || !ts.isExpression(argument)) {
    return undefined;
  }
  const index = parent.arguments.indexOf(argument);
  if (index < 0) {
    return undefined;
  }
  return { call: parent, argument, index };
}
