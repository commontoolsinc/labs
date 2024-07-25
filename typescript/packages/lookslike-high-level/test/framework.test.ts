import { describe, it, expect } from "vitest";
import {
  cell,
  isCell,
  lift,
  recipe,
  isReference,
  isModule,
  isRecipe,
} from "../src/framework/recipe.js";

describe("cell function", () => {
  it("creates a cell proxy", () => {
    const c = cell<number>();
    expect(isCell(c)).toBe(true);
  });

  it("supports get and set methods", () => {
    const c = cell<number>();
    c.set(5);
    expect(c.get()).toBe(c);
  });

  it("supports nested values", () => {
    const c = cell<{ a: number; b: string }>();
    c.a.set(5);
    c.b.set("test");
    expect(c.a.get()).toBe(c.a);
    expect(c.b.get()).toBe(c.b);
  });
});

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

describe("recipe function", () => {
  it("creates a recipe", () => {
    const doubleRecipe = recipe<{ x: number }, { double: number }>(
      "Double a number",
      (input) => {
        const double = lift<{ x: number }, number>(({ x }) => x * 2);
        return { double: double(input) };
      }
    );
    expect(isRecipe(doubleRecipe)).toBe(true);
  });
});

describe("utility functions", () => {
  it("isReference correctly identifies references", () => {
    expect(isReference({ $ref: ["path", "to", "value"] })).toBe(true);
    expect(isReference({ notRef: "something" })).toBe(false);
  });

  it("isModule correctly identifies modules", () => {
    expect(isModule({ type: "javascript", implementation: () => {} })).toBe(
      true
    );
    expect(isModule({ notModule: "something" })).toBe(false);
  });

  it("isRecipe correctly identifies recipes", () => {
    expect(isRecipe({ schema: {}, initial: {}, nodes: [] })).toBe(true);
    expect(isRecipe({ notRecipe: "something" })).toBe(false);
  });
});
