/**
 * Tests for CTButton component
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CTButton } from "./ct-button.ts";

describe("CTButton", () => {
  it("should be defined", () => {
    expect(CTButton).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("ct-button")).toBe(CTButton);
  });

  it("should create element instance", () => {
    const element = new CTButton();
    expect(element).toBeInstanceOf(CTButton);
  });

  it("should have default properties", () => {
    const element = new CTButton();
    expect(element.variant).toBe("primary");
    expect(element.size).toBe("default");
    expect(element.disabled).toBe(false);
    expect(element.type).toBe("button");
  });

  it("should suppress click events when disabled via host listener", () => {
    const element = new CTButton();
    element.disabled = true;

    // Verify the element has a capture-phase click listener that stops propagation
    // We test this by creating a click event and dispatching it
    let listenerCalled = false;
    element.addEventListener("click", () => {
      listenerCalled = true;
    });

    const clickEvent = new Event("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(clickEvent);

    // When disabled, the capture-phase listener should stop immediate propagation
    expect(listenerCalled).toBe(false);
  });

  it("should allow click events when not disabled", () => {
    const element = new CTButton();
    element.disabled = false;

    let listenerCalled = false;
    element.addEventListener("click", () => {
      listenerCalled = true;
    });

    const clickEvent = new Event("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(clickEvent);

    expect(listenerCalled).toBe(true);
  });
});
