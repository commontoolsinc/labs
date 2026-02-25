import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTRender } from "./ct-render.ts";

// NOTE: DOM lifecycle tests (cell swap cleanup, subscription management,
// disconnectedCallback) were removed because they relied on `document.body`
// which isn't available in Deno's test runner, and also tested against stale
// internal APIs (_cellValueUnsubscribe) that no longer exist on ct-render.
// Proper lifecycle tests should use the deno-web-test harness with real
// CellHandle instances. See packages/patterns/integration/ct-render.test.disabled.ts
// for the integration test pattern.

describe("CTRender", () => {
  it("should be defined", () => {
    expect(CTRender).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTRender.name).toBe("CTRender");
  });

  it("should create element instance", () => {
    const element = new CTRender();
    expect(element).toBeInstanceOf(CTRender);
  });

  it("should have cell property", () => {
    const element = new CTRender();
    expect(element.cell).toBeUndefined();
  });

  it("should have variant property", () => {
    const element = new CTRender();
    expect(element.variant).toBeUndefined();
  });
});

describe("CTRender variant handling", () => {
  it("should accept variant property", () => {
    const element = new CTRender();
    element.variant = "preview";
    expect(element.variant).toBe("preview");
  });

  it("should accept embedded variant", () => {
    const element = new CTRender();
    element.variant = "embedded";
    expect(element.variant).toBe("embedded");
  });

  it("should accept all valid variants", () => {
    const element = new CTRender();
    const variants = [
      "default",
      "preview",
      "thumbnail",
      "sidebar",
      "fab",
      "embedded",
    ] as const;

    for (const variant of variants) {
      element.variant = variant;
      expect(element.variant).toBe(variant);
    }
  });
});
