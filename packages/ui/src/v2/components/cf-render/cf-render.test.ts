import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import type { CellHandle } from "@commonfabric/runtime-client";
import { CFRender, hasVariantValue, normalizeVariant } from "./index.ts";

function stylesText(): string {
  const styles = Array.isArray(CFRender.styles)
    ? CFRender.styles
    : [CFRender.styles];
  return (styles as Array<{ cssText: string }>)
    .map((style) => style.cssText)
    .join("\n");
}

// NOTE: Full rendering lifecycle tests (cell swap cleanup, subscription
// management, render-into-container) require a real DOM with document.body
// and Lit's rendering pipeline. These can't run in Deno's headless test
// runner. The tests below cover what's verifiable without DOM: property
// handling, cell assignment, variant configuration, and disconnectedCallback
// state reset. For full integration tests, use a browser-based test harness.

describe("CFRender", () => {
  it("should be defined", () => {
    expect(CFRender).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CFRender.name).toBe("CFRender");
  });

  it("should create element instance", () => {
    const element = new CFRender();
    expect(element).toBeInstanceOf(CFRender);
  });

  it("should have cell property initially undefined", () => {
    const element = new CFRender();
    expect(element.cell).toBeUndefined();
  });

  it("should have variant property initially undefined", () => {
    const element = new CFRender();
    expect(element.variant).toBeUndefined();
  });

  it("should accept a CellHandle as cell property", () => {
    const element = new CFRender();
    const cell = createMockCellHandle({ ui: "some-vnode" });
    element.cell = cell as CellHandle;
    expect(element.cell).toBe(cell);
  });

  it("owns the theme-aware pending presentation", () => {
    const styles = stylesText();
    expect(styles).toContain('[data-cf-pending="true"]');
    expect(styles).toContain("--cf-render-pending-opacity");
    expect(styles).toContain("--cf-render-pending-filter");
    expect(styles).toContain("grayscale");
    expect(styles).toContain(
      'span[style*="display"][style*="contents"]',
    );
  });
});

describe("CFRender variant handling", () => {
  it("should accept variant property", () => {
    const element = new CFRender();
    element.variant = "chip";
    expect(element.variant).toBe("chip");
  });

  it("should accept tile variant", () => {
    const element = new CFRender();
    element.variant = "tile";
    expect(element.variant).toBe("tile");
  });

  it("should accept all valid variants", () => {
    const element = new CFRender();
    const variants = ["full", "chip", "tile"] as const;

    for (const variant of variants) {
      element.variant = variant;
      expect(element.variant).toBe(variant);
    }
  });
});

describe("normalizeVariant", () => {
  it("passes through the known spectrum", () => {
    expect(normalizeVariant("full")).toBe("full");
    expect(normalizeVariant("chip")).toBe("chip");
    expect(normalizeVariant("tile")).toBe("tile");
  });

  it("falls back to full for undefined and unknown/legacy values", () => {
    expect(normalizeVariant(undefined)).toBe("full");
    expect(normalizeVariant("")).toBe("full");
    expect(normalizeVariant("default")).toBe("full");
    expect(normalizeVariant("preview")).toBe("full");
    expect(normalizeVariant("embedded")).toBe("full");
  });
});

describe("hasVariantValue", () => {
  it("is true only when the key holds a renderable value", () => {
    expect(hasVariantValue({ "$CHIP_UI": { type: "vnode" } }, "$CHIP_UI"))
      .toBe(true);
    expect(hasVariantValue({ "$UI": {} }, "$TILE_UI")).toBe(false);
    expect(hasVariantValue({ "$TILE_UI": undefined }, "$TILE_UI")).toBe(false);
    expect(hasVariantValue({ "$TILE_UI": null }, "$TILE_UI")).toBe(false);
  });

  it("is false for non-object / empty values (failover to default)", () => {
    expect(hasVariantValue(undefined, "$CHIP_UI")).toBe(false);
    expect(hasVariantValue(null, "$CHIP_UI")).toBe(false);
    expect(hasVariantValue("nope", "$CHIP_UI")).toBe(false);
    expect(hasVariantValue({}, "$CHIP_UI")).toBe(false);
  });
});

describe("CFRender render-error handling", () => {
  function cellWithSignal(aborted: boolean): CellHandle {
    return {
      runtime: () => ({ signal: { aborted } }),
    } as unknown as CellHandle;
  }

  function captureConsoleError(fn: () => void): unknown[][] {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      fn();
    } finally {
      console.error = original;
    }
    return calls;
  }

  it("logs render errors while the runtime is alive", () => {
    const element = new CFRender();
    element.cell = cellWithSignal(false);
    const calls = captureConsoleError(() => {
      (element as unknown as { _handleRenderError(e: unknown): void })
        ._handleRenderError(new Error("boom"));
    });
    expect(calls.length).toBe(1);
  });

  it("suppresses render-error logging when the runtime is disposed", () => {
    const element = new CFRender();
    element.cell = cellWithSignal(true);
    const calls = captureConsoleError(() => {
      (element as unknown as { _handleRenderError(e: unknown): void })
        ._handleRenderError(new DOMException("aborted", "AbortError"));
    });
    expect(calls.length).toBe(0);
  });
});

describe("CFRender disconnectedCallback", () => {
  it("should reset state on disconnect", () => {
    const element = new CFRender();
    const cell = createMockCellHandle({ name: "test" });
    element.cell = cell as CellHandle;
    element.variant = "chip";

    // disconnectedCallback should clean up internal state without throwing
    element.disconnectedCallback();

    // Cell and variant are Lit properties — not cleared by disconnectedCallback
    // (Lit preserves properties across disconnect/reconnect).
    // The internal _renderingCellId and _hasRendered are reset though.
    // We verify it doesn't throw and the element is still usable.
    expect(element.cell).toBe(cell);
    expect(element.variant).toBe("chip");
  });

  it("should handle disconnect when no cell was set", () => {
    const element = new CFRender();
    // Should not throw even with no cell
    element.disconnectedCallback();
  });
});
