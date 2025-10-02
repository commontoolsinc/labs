/**
 * Calculate optimal menu position to avoid viewport clipping
 *
 * @param anchorRect - Bounding rect of the element to anchor the menu to
 * @param menuElement - The menu element to position
 * @param options - Positioning options
 * @returns Position object with top/left coordinates
 */
export interface MenuPositionOptions {
  /** Gap between anchor and menu (default: 6) */
  gap?: number;
  /** Minimum padding from viewport edges (default: 8) */
  viewportPadding?: number;
  /** Preferred vertical alignment: 'below' | 'above' (default: 'below') */
  preferredVertical?: "below" | "above";
  /** Preferred horizontal alignment: 'left' | 'right' (default: 'left') */
  preferredHorizontal?: "left" | "right";
}

export interface MenuPosition {
  top: number;
  left: number;
}

/**
 * Calculate optimal menu position with viewport clamping and flip behavior.
 * Based on logic from ct-tools-chip component.
 */
export function calculateMenuPosition(
  anchorRect: DOMRect,
  menuElement: HTMLElement,
  options: MenuPositionOptions = {},
): MenuPosition {
  const {
    gap = 6,
    viewportPadding = 8,
    preferredVertical = "below",
    preferredHorizontal = "left",
  } = options;

  const vw = globalThis.innerWidth;
  const vh = globalThis.innerHeight;

  // Start with preferred position
  let top = preferredVertical === "below"
    ? anchorRect.bottom + gap
    : anchorRect.top - gap;
  let left = preferredHorizontal === "left"
    ? anchorRect.left
    : anchorRect.right;

  // Get menu dimensions
  const menuRect = menuElement.getBoundingClientRect();

  // Horizontal clamping
  if (menuRect.right > vw - viewportPadding) {
    left = Math.max(viewportPadding, vw - menuRect.width - viewportPadding);
  }
  if (left < viewportPadding) {
    left = viewportPadding;
  }

  // Vertical flip if overflow bottom
  if (preferredVertical === "below" && menuRect.bottom > vh - viewportPadding) {
    const above = anchorRect.top - menuRect.height - gap;
    if (above >= viewportPadding) {
      // Enough space above - flip to above
      top = above;
    } else {
      // Not enough space above either - clamp to viewport
      top = Math.max(viewportPadding, vh - menuRect.height - viewportPadding);
    }
  }

  // Vertical flip if overflow top (when preferring above)
  if (preferredVertical === "above" && menuRect.top < viewportPadding) {
    const below = anchorRect.bottom + gap;
    if (below + menuRect.height <= vh - viewportPadding) {
      // Enough space below - flip to below
      top = below;
    } else {
      // Not enough space below either - clamp to viewport
      top = viewportPadding;
    }
  }

  return {
    top: Math.round(top),
    left: Math.round(left),
  };
}

/**
 * Apply menu position with requestAnimationFrame for smooth rendering
 */
export function applyMenuPosition(
  anchorRect: DOMRect,
  menuElement: HTMLElement,
  options: MenuPositionOptions = {},
): void {
  // Set initial position for measurement
  menuElement.style.position = "fixed";
  menuElement.style.top = "0px";
  menuElement.style.left = "0px";

  // Calculate and apply position in next frame
  requestAnimationFrame(() => {
    const position = calculateMenuPosition(anchorRect, menuElement, options);
    menuElement.style.top = `${position.top}px`;
    menuElement.style.left = `${position.left}px`;
  });
}
