/**
 * Tests for CTPicker component
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CTPicker } from "./ct-picker.ts";

describe("CTPicker", () => {
  it("should be defined", () => {
    expect(CTPicker).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("ct-picker")).toBe(CTPicker);
  });

  it("should create element instance", () => {
    const element = new CTPicker();
    expect(element).toBeInstanceOf(CTPicker);
  });

  it("should have default properties", () => {
    const element = new CTPicker();
    expect(element.disabled).toBe(false);
    expect(element.minHeight).toBe("");
  });

  it("should have disabled state property", () => {
    const element = new CTPicker();
    expect(element.disabled).toBe(false);

    element.disabled = true;
    expect(element.disabled).toBe(true);
  });

  it("should expose public API methods", () => {
    const element = new CTPicker();
    expect(typeof element.getSelectedIndex).toBe("function");
    expect(typeof element.getSelectedItem).toBe("function");
    expect(typeof element.selectByIndex).toBe("function");
  });

  it("should initialize with index 0", () => {
    const element = new CTPicker();
    expect(element.getSelectedIndex()).toBe(0);
  });

  it("should accept custom minHeight", () => {
    const element = new CTPicker();
    element.minHeight = "300px";
    expect(element.minHeight).toBe("300px");
  });
});
