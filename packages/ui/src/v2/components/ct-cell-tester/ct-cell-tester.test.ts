import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTCellTester } from "./ct-cell-tester.ts";
import { createSimpleCell } from "../ct-outliner/simple-cell.ts";

describe("CTCellTester", () => {
  it("should create and render", () => {
    const tester = new CTCellTester();
    expect(tester).toBeTruthy();
  });

  it("should display cell value", async () => {
    const cell = createSimpleCell(42);
    const tester = new CTCellTester();
    tester.cell = cell;
    
    // Wait for render
    await tester.updateComplete;
    
    // Should display the current value
    const content = tester.shadowRoot?.textContent;
    expect(content).toContain("42");
  });

  it("should update cell value when button is clicked", async () => {
    const cell = createSimpleCell(0);
    const tester = new CTCellTester();
    tester.cell = cell;
    
    // Wait for render
    await tester.updateComplete;
    
    // Click the button
    const button = tester.shadowRoot?.querySelector("button");
    expect(button).toBeTruthy();
    
    button?.click();
    
    // The cell value should have changed
    const newValue = cell.get();
    expect(newValue).not.toBe(0);
    expect(typeof newValue).toBe("number");
    expect(newValue).toBeGreaterThanOrEqual(0);
    expect(newValue).toBeLessThan(1000);
  });

  it("should handle disabled state when no cell is provided", async () => {
    const tester = new CTCellTester();
    
    // Wait for render
    await tester.updateComplete;
    
    // Button should be disabled
    const button = tester.shadowRoot?.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(true);
  });
});