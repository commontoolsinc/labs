/**
 * Tests for CTCopyButton component
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CTCopyButton } from "./ct-copy-button.ts";

describe("CTCopyButton", () => {
  it("should be defined", () => {
    expect(CTCopyButton).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("ct-copy-button")).toBe(CTCopyButton);
  });

  it("should create element instance", () => {
    const element = new CTCopyButton();
    expect(element).toBeInstanceOf(CTCopyButton);
  });

  it("should have default properties", () => {
    const element = new CTCopyButton();
    expect(element.text).toBe("");
    expect(element.variant).toBe("secondary");
    expect(element.size).toBe("default");
    expect(element.disabled).toBe(false);
    expect(element.feedbackDuration).toBe(2000);
    expect(element.iconOnly).toBe(false);
  });
});
