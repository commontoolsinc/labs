export const PENDING_RENDER_ATTRIBUTE = "data-cf-pending";

interface AttributeElement extends Node {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface PendingAttributeSnapshot {
  readonly inert: string | null;
  readonly ariaBusy: string | null;
}

const pendingAttributeSnapshots = new WeakMap<
  AttributeElement,
  PendingAttributeSnapshot
>();

function isAttributeElement(node: Node | null): node is AttributeElement {
  return node !== null &&
    typeof (node as Partial<AttributeElement>).setAttribute === "function" &&
    typeof (node as Partial<AttributeElement>).getAttribute === "function" &&
    typeof (node as Partial<AttributeElement>).removeAttribute === "function";
}

function restoreAttribute(
  node: AttributeElement,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    node.removeAttribute(name);
  } else {
    node.setAttribute(name, value);
  }
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
    if (!pendingAttributeSnapshots.has(node)) {
      pendingAttributeSnapshots.set(node, {
        inert: node.getAttribute("inert"),
        ariaBusy: node.getAttribute("aria-busy"),
      });
    }
    node.setAttribute(PENDING_RENDER_ATTRIBUTE, "true");
    node.setAttribute("inert", "");
    node.setAttribute("aria-busy", "true");
  } else {
    node.removeAttribute(PENDING_RENDER_ATTRIBUTE);
    const snapshot = pendingAttributeSnapshots.get(node);
    if (snapshot) {
      restoreAttribute(node, "inert", snapshot.inert);
      restoreAttribute(node, "aria-busy", snapshot.ariaBusy);
      pendingAttributeSnapshots.delete(node);
    }
  }
}
