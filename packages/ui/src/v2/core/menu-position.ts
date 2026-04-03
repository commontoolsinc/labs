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

  // Measure menu dimensions (width/height only)
  const rect = menuElement.getBoundingClientRect();
  const menuWidth = rect.width;
  const menuHeight = rect.height;

  // Compute projected left based on preference
  let left = preferredHorizontal === "left"
    ? anchorRect.left
    : anchorRect.right - menuWidth;

  // Clamp horizontally within viewport padding
  if (left + menuWidth > vw - viewportPadding) {
    left = Math.max(viewportPadding, vw - menuWidth - viewportPadding);
  }
  if (left < viewportPadding) left = viewportPadding;

  // Compute projected top based on preference
  let top = preferredVertical === "below"
    ? anchorRect.bottom + gap
    : anchorRect.top - gap - menuHeight;

  // Flip if overflowing bottom when preferring below
  if (
    preferredVertical === "below" && top + menuHeight > vh - viewportPadding
  ) {
    const above = anchorRect.top - gap - menuHeight;
    if (above >= viewportPadding) top = above;
    else top = Math.max(viewportPadding, vh - menuHeight - viewportPadding);
  }

  // Flip if overflowing top when preferring above
  if (preferredVertical === "above" && top < viewportPadding) {
    const below = anchorRect.bottom + gap;
    if (below + menuHeight <= vh - viewportPadding) top = below;
    else top = viewportPadding;
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
  // Leave current position untouched; calculation uses width/height only

  // Calculate and apply position in next frame
  requestAnimationFrame(() => {
    const position = calculateMenuPosition(anchorRect, menuElement, options);
    menuElement.style.top = `${position.top}px`;
    menuElement.style.left = `${position.left}px`;
  });
}
