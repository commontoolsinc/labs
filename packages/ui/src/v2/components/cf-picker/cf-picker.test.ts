/**
 * Tests for CFPicker component
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFPicker } from "./cf-picker.ts";

describe("CFPicker", () => {
  it("should be defined", () => {
    expect(CFPicker).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-picker")).toBe(CFPicker);
  });

  it("should create element instance", () => {
    const element = new CFPicker();
    expect(element).toBeInstanceOf(CFPicker);
  });

  it("should have default properties", () => {
    const element = new CFPicker();
    expect(element.disabled).toBe(false);
    expect(element.minHeight).toBe("");
  });

  it("should have disabled state property", () => {
    const element = new CFPicker();
    expect(element.disabled).toBe(false);

    element.disabled = true;
    expect(element.disabled).toBe(true);
  });

  it("should expose public API methods", () => {
    const element = new CFPicker();
    expect(typeof element.getSelectedIndex).toBe("function");
    expect(typeof element.getSelectedItem).toBe("function");
    expect(typeof element.selectByIndex).toBe("function");
  });

  it("should initialize with index 0", () => {
    const element = new CFPicker();
    expect(element.getSelectedIndex()).toBe(0);
  });

  it("should accept custom minHeight", () => {
    const element = new CFPicker();
    element.minHeight = "300px";
    expect(element.minHeight).toBe("300px");
  });
});
