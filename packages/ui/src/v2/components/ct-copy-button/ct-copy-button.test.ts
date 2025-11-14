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

  it("should accept text property", () => {
    const element = new CTCopyButton();
    element.text = "Hello, World!";
    expect(element.text).toBe("Hello, World!");
  });

  it("should support different variants", () => {
    const element = new CTCopyButton();
    element.variant = "primary";
    expect(element.variant).toBe("primary");
  });

  it("should support different sizes", () => {
    const element = new CTCopyButton();
    element.size = "sm";
    expect(element.size).toBe("sm");
  });

  it("should support icon-only mode", () => {
    const element = new CTCopyButton();
    element.iconOnly = true;
    expect(element.iconOnly).toBe(true);
  });

  it("should support custom feedback duration", () => {
    const element = new CTCopyButton();
    element.feedbackDuration = 5000;
    expect(element.feedbackDuration).toBe(5000);
  });
});
