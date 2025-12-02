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
    expect(element.minHeight).toBe("200px");
    expect(element.items).toEqual([]);
  });

  it("should support setting items", () => {
    const element = new CTPicker();
    const testItems = [{}, {}, {}] as any[]; // Mock cells
    element.items = testItems;
    expect(element.items).toBe(testItems);
    expect(element.items.length).toBe(3);
  });

  it("should support plain value", () => {
    const element = new CTPicker();
    element.value = "test-value";
    expect(element.value).toBe("test-value");
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

  it("should return undefined for selected item when items is empty", () => {
    const element = new CTPicker();
    expect(element.getSelectedItem()).toBeUndefined();
  });

  it("should return selected item when items exist", () => {
    const element = new CTPicker();
    const testItems = [{ id: 1 }, { id: 2 }, { id: 3 }] as any[];
    element.items = testItems;

    expect(element.getSelectedItem()).toBe(testItems[0]);
  });

  it("should select item by index", () => {
    const element = new CTPicker();
    const testItems = [{ id: 1 }, { id: 2 }, { id: 3 }] as any[];
    element.items = testItems;

    element.selectByIndex(1);
    expect(element.getSelectedIndex()).toBe(1);
    expect(element.getSelectedItem()).toBe(testItems[1]);
  });

  it("should not select invalid index", () => {
    const element = new CTPicker();
    const testItems = [{ id: 1 }, { id: 2 }] as any[];
    element.items = testItems;

    const initialIndex = element.getSelectedIndex();
    element.selectByIndex(99); // Out of bounds
    expect(element.getSelectedIndex()).toBe(initialIndex);
  });

  it("should handle negative index gracefully", () => {
    const element = new CTPicker();
    const testItems = [{ id: 1 }, { id: 2 }] as any[];
    element.items = testItems;

    const initialIndex = element.getSelectedIndex();
    element.selectByIndex(-1);
    expect(element.getSelectedIndex()).toBe(initialIndex);
  });

  it("should accept custom minHeight", () => {
    const element = new CTPicker();
    element.minHeight = "300px";
    expect(element.minHeight).toBe("300px");
  });
});
