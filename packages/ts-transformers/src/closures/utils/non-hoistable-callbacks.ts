import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";

export function markCallbackAndAncestorsNonHoistable(
  node: ts.Node,
  context: TransformationContext,
): void {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionLike(current)) {
      context.markAsNonHoistableCallback(current);
    }
    if (ts.isSourceFile(current)) {
      return;
    }
    current = current.parent;
  }
}
