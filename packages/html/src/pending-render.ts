export const PENDING_RENDER_ATTRIBUTE = "data-cf-pending";

interface AttributeElement extends Node {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function isAttributeElement(node: Node | null): node is AttributeElement {
  return node !== null &&
    typeof (node as Partial<AttributeElement>).setAttribute === "function" &&
    typeof (node as Partial<AttributeElement>).removeAttribute === "function";
}

/**
 * Mark retained content as stale while its replacement is pending.
 *
 * `inert` blocks pointer and focus interaction. `aria-busy` tells assistive
 * technology that the retained subtree is not the current result.
 */
export function setPendingRenderState(
  node: Node | null,
  pending: boolean,
): void {
  if (!isAttributeElement(node)) return;

  if (pending) {
    node.setAttribute(PENDING_RENDER_ATTRIBUTE, "true");
    node.setAttribute("inert", "");
    node.setAttribute("aria-busy", "true");
  } else {
    node.removeAttribute(PENDING_RENDER_ATTRIBUTE);
    node.removeAttribute("inert");
    node.removeAttribute("aria-busy");
  }
}
