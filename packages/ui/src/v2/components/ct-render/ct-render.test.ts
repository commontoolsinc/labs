import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTRender } from "./ct-render.ts";

describe("CTRender", () => {
  it("should be defined", () => {
    expect(CTRender).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTRender.name).toBe("CTRender");
  });

  it("should format fallback for primitive values", () => {
    const element = new CTRender();
    
    // Test the _formatFallback method (access private method for testing)
    const formatFallback = (element as any)._formatFallback;
    
    expect(formatFallback("hello")).toBe("hello");
    expect(formatFallback(123)).toBe("123");
    expect(formatFallback(null)).toBe("");
    expect(formatFallback(undefined)).toBe("");
    
    // Test with mock cell
    const mockCell = {
      get: () => "cell value"
    };
    expect(formatFallback(mockCell)).toBe("cell value");
  });

  it("should handle basic property setting", () => {
    const element = new CTRender();
    
    const mockCell = {
      get: () => "test"
    };
    
    element.cell = mockCell;
    expect(element.cell).toBe(mockCell);
  });
});