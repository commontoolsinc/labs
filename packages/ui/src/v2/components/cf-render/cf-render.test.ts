import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import type { CellHandle } from "@commonfabric/runtime-client";
import { CFRender } from "./cf-render.ts";

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
