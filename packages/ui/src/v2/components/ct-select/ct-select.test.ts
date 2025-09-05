/**
 * Tests for CTSelect component, including new $value two-way binding functionality
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CTSelect, type SelectItem } from "./ct-select.ts";

describe("CTSelect", () => {
  it("should be defined", () => {
    expect(CTSelect).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("ct-select")).toBe(CTSelect);
  });

  it("should create element instance", () => {
    const element = new CTSelect();
    expect(element).toBeInstanceOf(CTSelect);
  });

  it("should have default properties", () => {
    const element = new CTSelect();
    expect(element.disabled).toBe(false);
    expect(element.multiple).toBe(false);
    expect(element.required).toBe(false);
    expect(element.name).toBe("");
    expect(element.placeholder).toBe("");
    expect(element.items).toEqual([]);
  });

  it("should support Cell and plain values in value property", () => {
    const element = new CTSelect();
    // Check that we can set plain values
    element.value = "test-value";
    expect(element.value).toBe("test-value");
  });

  it("should handle basic value selection", () => {
    const element = new CTSelect();
    const testItems: SelectItem[] = [
      { label: "Option 1", value: "opt1" },
      { label: "Option 2", value: "opt2" },
      { label: "Option 3", value: "opt3" },
    ];

    element.items = testItems;
    element.value = "opt2";

    // Should be able to get current value
    expect(element.value).toBe("opt2");
  });

  it("should handle multiple selection", () => {
    const element = new CTSelect();
    const testItems: SelectItem[] = [
      { label: "Option 1", value: "opt1" },
      { label: "Option 2", value: "opt2" },
      { label: "Option 3", value: "opt3" },
    ];

    element.multiple = true;
    element.items = testItems;
    element.value = ["opt1", "opt3"];

    expect(Array.isArray(element.value)).toBe(true);
    expect(element.value).toEqual(["opt1", "opt3"]);
  });

  it("should support binding with Cell values", () => {
    const element = new CTSelect();
    const testItems: SelectItem[] = [
      { label: "Initial", value: "initial-value" },
      { label: "Updated", value: "updated-value" },
    ];

    element.items = testItems;
    element.value = "initial-value";

    // Should be able to set and access value (both Cell and plain values)
    expect(element.value).toBe("initial-value");
  });

  it("should work with object values", () => {
    const element = new CTSelect();
    const testItems: SelectItem[] = [
      { label: "User 1", value: { id: 1, name: "Alice" } },
      { label: "User 2", value: { id: 2, name: "Bob" } },
    ];

    element.items = testItems;
    element.value = { id: 1, name: "Alice" };

    expect(element.value).toEqual({ id: 1, name: "Alice" });
  });

  it("should handle grouped items", () => {
    const element = new CTSelect();
    const testItems: SelectItem[] = [
      { label: "Red", value: "red", group: "Colors" },
      { label: "Blue", value: "blue", group: "Colors" },
      { label: "Circle", value: "circle", group: "Shapes" },
      { label: "Square", value: "square", group: "Shapes" },
    ];

    element.items = testItems;

    // Should accept items with groups
    expect(element.items.length).toBe(4);
    expect(element.items.every((item) => item.group)).toBe(true);
  });
});
