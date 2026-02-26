import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { calculateMenuPosition } from "./menu-position.ts";

// Mock viewport dimensions (saved/restored per test)
let originalInnerWidth: number;
let originalInnerHeight: number;

function setViewport(width: number, height: number) {
  Object.defineProperty(globalThis, "innerWidth", {
    value: width,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    value: height,
    writable: true,
    configurable: true,
  });
}

/** Create a mock DOMRect */
function rect(
  x: number,
  y: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => {},
  } as DOMRect;
}

/** Create a mock menu element with given dimensions */
function mockMenu(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => rect(0, 0, width, height),
  } as unknown as HTMLElement;
}

beforeEach(() => {
  originalInnerWidth = globalThis.innerWidth;
  originalInnerHeight = globalThis.innerHeight;
  setViewport(1024, 768);
});

afterEach(() => {
  Object.defineProperty(globalThis, "innerWidth", {
    value: originalInnerWidth,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    value: originalInnerHeight,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Basic positioning
// ---------------------------------------------------------------------------

describe("calculateMenuPosition — basic", () => {
  it("positions below anchor by default", () => {
    const anchor = rect(100, 50, 200, 30); // anchor at (100,50), 200x30
    const menu = mockMenu(150, 100);

    const pos = calculateMenuPosition(anchor, menu);
    // Below: anchor.bottom (80) + gap (6) = 86
    expect(pos.top).toBe(86);
    // Left-aligned: anchor.left (100)
    expect(pos.left).toBe(100);
  });

  it("positions above anchor when preferred", () => {
    const anchor = rect(100, 200, 200, 30);
    const menu = mockMenu(150, 80);

    const pos = calculateMenuPosition(anchor, menu, {
      preferredVertical: "above",
    });
    // Above: anchor.top (200) - gap (6) - menuHeight (80) = 114
    expect(pos.top).toBe(114);
  });

  it("right-aligns menu when preferred", () => {
    const anchor = rect(300, 50, 200, 30);
    const menu = mockMenu(150, 100);

    const pos = calculateMenuPosition(anchor, menu, {
      preferredHorizontal: "right",
    });
    // Right-aligned: anchor.right (500) - menuWidth (150) = 350
    expect(pos.left).toBe(350);
  });

  it("respects custom gap", () => {
    const anchor = rect(100, 50, 200, 30);
    const menu = mockMenu(150, 100);

    const pos = calculateMenuPosition(anchor, menu, { gap: 20 });
    // Below: anchor.bottom (80) + gap (20) = 100
    expect(pos.top).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Viewport clamping and flip
// ---------------------------------------------------------------------------

describe("calculateMenuPosition — viewport clamping", () => {
  it("clamps menu to right edge of viewport", () => {
    setViewport(400, 768);
    const anchor = rect(300, 50, 100, 30); // near right edge
    const menu = mockMenu(200, 100);

    const pos = calculateMenuPosition(anchor, menu);
    // Menu would extend to 500, viewport is 400
    // Clamped: max(8, 400 - 200 - 8) = 192
    expect(pos.left).toBe(192);
  });

  it("clamps menu to left edge of viewport", () => {
    const anchor = rect(0, 50, 50, 30); // at left edge
    const menu = mockMenu(200, 100);

    const pos = calculateMenuPosition(anchor, menu);
    // anchor.left (0) < viewportPadding (8), so clamped to 8
    expect(pos.left).toBe(8);
  });

  it("flips to above when below would overflow viewport", () => {
    setViewport(1024, 300);
    const anchor = rect(100, 200, 200, 30); // near bottom
    const menu = mockMenu(150, 100);

    const pos = calculateMenuPosition(anchor, menu);
    // Below would be 236 + 100 = 336 > 300 - 8 = 292 → overflow
    // Above: anchor.top (200) - gap (6) - menuHeight (100) = 94
    expect(pos.top).toBe(94);
  });

  it("flips to below when above would overflow viewport", () => {
    const anchor = rect(100, 30, 200, 30); // near top
    const menu = mockMenu(150, 100);

    const pos = calculateMenuPosition(anchor, menu, {
      preferredVertical: "above",
    });
    // Above would be 30 - 6 - 100 = -76 < 8 → overflow
    // Below: anchor.bottom (60) + gap (6) = 66
    expect(pos.top).toBe(66);
  });

  it("clamps to viewport when both above and below overflow", () => {
    setViewport(1024, 120); // tiny viewport
    const anchor = rect(100, 50, 200, 30);
    const menu = mockMenu(150, 200); // taller than viewport

    const pos = calculateMenuPosition(anchor, menu);
    // Below overflows, above overflows too (50 - 6 - 200 = -156)
    // Fallback: max(8, 120 - 200 - 8) = 8
    expect(pos.top).toBe(8);
  });
});
