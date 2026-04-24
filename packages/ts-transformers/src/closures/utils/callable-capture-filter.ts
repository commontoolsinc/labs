import ts from "typescript";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";

/**
 * Explicit closure state/params cannot faithfully transport plain callable
 * captures today. Keep direct callable root captures lexical instead of routing
 * them through generated handler/derive/map params objects.
 */
export function filterDirectCallableCaptures(
  captureTree: Map<string, CaptureTreeNode>,
  checker: ts.TypeChecker,
): Map<string, CaptureTreeNode> {
  const filtered = new Map<string, CaptureTreeNode>();

  for (const [name, node] of captureTree) {
    if (isDirectCallableCapture(node, checker)) {
      continue;
    }
    filtered.set(name, node);
  }

  return filtered;
}

function isDirectCallableCapture(
  node: CaptureTreeNode,
  checker: ts.TypeChecker,
): boolean {
  if (
    !node.expression || node.path.length !== 0 || node.properties.size !== 0
  ) {
    return false;
  }

  const type = checker.getTypeAtLocation(node.expression);
  return type.getCallSignatures().length > 0;
}
