export const PENDING_RENDER_ATTRIBUTE = "data-cf-pending";

const PENDING_RENDER_STYLE_ATTRIBUTE = "data-cf-pending-styles";

export const PENDING_RENDER_STYLES = `
[data-cf-pending="true"] {
  opacity: var(--cf-pending-opacity, 0.55) !important;
  filter: grayscale(0.8) !important;
}

:is(cf-fragment, span[style*="display"][style*="contents"])[data-cf-pending="true"] {
  opacity: 1 !important;
  filter: none !important;
}

:is(cf-fragment, span[style*="display"][style*="contents"])[data-cf-pending="true"] > * {
  opacity: var(--cf-pending-opacity, 0.55) !important;
  filter: grayscale(0.8) !important;
}
`;

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

/** Install the pending treatment in the document or shadow root being used. */
export function ensurePendingRenderStyles(
  container: HTMLElement,
  document: Document,
): void {
  if (
    typeof container.getRootNode !== "function" ||
    typeof document.createElement !== "function"
  ) {
    return;
  }

  const root = container.getRootNode();
  const queryRoot = root.nodeType === 9 || root.nodeType === 11
    ? root as Document | ShadowRoot
    : container;
  if (
    typeof queryRoot.querySelector === "function" &&
    queryRoot.querySelector(`style[${PENDING_RENDER_STYLE_ATTRIBUTE}]`)
  ) {
    return;
  }

  const host = root.nodeType === 9
    ? (root as Document).head ?? (root as Document).documentElement
    : root.nodeType === 11
    ? root as ShadowRoot
    : container;
  if (!host || typeof host.appendChild !== "function") return;

  const style = document.createElement("style");
  style.setAttribute(PENDING_RENDER_STYLE_ATTRIBUTE, "true");
  style.textContent = PENDING_RENDER_STYLES;
  host.appendChild(style);
}
