/**
 * Tests for CFButton component
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFButton } from "./cf-button.ts";

describe("CFButton", () => {
  it("should be defined", () => {
    expect(CFButton).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-button")).toBe(CFButton);
  });

  it("should create element instance", () => {
    const element = new CFButton();
    expect(element).toBeInstanceOf(CFButton);
  });

  it("should have default properties", () => {
    const element = new CFButton();
    expect(element.variant).toBe("primary");
    expect(element.size).toBe("default");
    expect(element.disabled).toBe(false);
    expect(element.type).toBe("button");
  });

  it("should suppress click events when disabled via host listener", () => {
    const element = new CFButton();
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
    const element = new CFButton();
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
