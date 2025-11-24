/**
 * Slot helper utilities for web components
 */

/**
 * Check if a DOM node has meaningful content.
 *
 * This filters out:
 * - Whitespace-only text nodes
 * - Elements that only contain whitespace text nodes
 *
 * But considers as content:
 * - Non-whitespace text
 * - Self-contained elements (images, icons, custom elements with no children)
 * - Elements containing child elements (buttons, icons, etc.)
 * - Elements with non-whitespace text content
 *
 * @param node - The DOM node to check
 * @returns true if the node has meaningful content, false otherwise
 */
export function nodeHasContent(node: Node): boolean {
  // Whitespace-only text nodes are not content
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent?.trim() || "") !== "";
  }

  // Element nodes: check if they're truly empty
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    // Elements with no children are considered content
    // (images, icons, custom elements, etc.)
    if (element.childNodes.length === 0) {
      return true;
    }
    // If element has any child elements (not just text nodes), it has content
    if (element.children.length > 0) {
      return true;
    }
    // Only text children: check if any have non-whitespace content
    if ((element.textContent?.trim() || "") === "") {
      return false;
    }
  }

  // Other nodes or non-empty elements are content
  return true;
}

/**
 * Check if a slot has meaningful content assigned to it.
 *
 * This is useful for conditionally showing/hiding sections based on
 * whether slots are populated, while correctly handling whitespace
 * and empty elements.
 *
 * @param slot - The HTMLSlotElement to check
 * @returns true if the slot has meaningful content, false otherwise
 *
 * @example
 * ```typescript
 * const headerSlot = this.shadowRoot?.querySelector('slot[name="header"]');
 * const hasHeader = slotHasContent(headerSlot);
 * this.classList.toggle('no-header', !hasHeader);
 * ```
 */
export function slotHasContent(
  slot: HTMLSlotElement | null | undefined,
): boolean {
  if (!slot) return false;
  return slot.assignedNodes().some(nodeHasContent);
}
