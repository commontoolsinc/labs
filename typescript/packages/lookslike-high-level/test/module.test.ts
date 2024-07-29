import { describe, it, expect } from "vitest";
import { isCell, isModule } from "../src/framework/types.js";
import { lift } from "../src/framework/module.js";
import { cell } from "../src/framework/cell-proxy.js";

describe("lift function", () => {
  it("creates a node factory", () => {
    const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
    expect(typeof add).toBe("function");
    expect(isModule(add)).toBe(true);
  });

  it("creates a cell proxy when called", () => {
    const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
    const result = add({ a: cell(1), b: cell(2) });
    expect(isCell(result)).toBe(true);
  });
});
