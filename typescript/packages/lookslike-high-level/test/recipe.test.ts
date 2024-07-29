import { describe, it, expect } from "vitest";
import { isRecipe } from "../src/framework/types.js";
import { lift } from "../src/framework/module.js";
import { recipe } from "../src/framework/recipe.js";

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
