import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";

export interface ClosureTransformationStrategy {
  /**
   * Determines if this strategy can transform the given node.
   */
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean;

  /**
   * Transforms the node.
   * Returns the transformed node, or undefined if transformation failed or wasn't applicable.
   */
  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined;
}
