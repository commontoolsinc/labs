import { describe, it, expect } from "vitest";
import { CellProxy, isRecipe, isModule } from "../src/framework/types.js";
import { lift } from "../src/framework/module.js";
import { recipe } from "../src/framework/recipe.js";

describe("recipe function", () => {
  it("creates a recipe", () => {
    const doubleRecipe = recipe<{ x: number }>("Double a number", ({ x }) => {
      const double = lift(({ x }) => x * 2);
      return { double: double({ x }) };
    });
    expect(isRecipe(doubleRecipe)).toBe(true);
  });

  it("creates a recipe, with simple function", () => {
    const doubleRecipe = recipe<{ x: number }>("Double a number", ({ x }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(x) };
    });
    expect(isRecipe(doubleRecipe)).toBe(true);
  });

  it("creates a more complex recipe and correctly serializes it", () => {
    const doubleRecipe = recipe<{ x: number }>("Double a number", ({ x }) => {
      // TODO: Fix types
      (x as CellProxy<number>).setDefault(1);
      const double = lift<number>((x) => x * 2);
      return { double: double(double(x)) };
    });
    expect(isRecipe(doubleRecipe)).toBe(true);
    const { schema, initial, nodes } = doubleRecipe;
    expect(schema).toMatchObject({
      description: "Double a number",
      type: "object",
      properties: {
        double: { properties: { $ref: { type: "array" } } },
        x: { type: "integer", default: 1 },
      },
    });
    expect(initial).toEqual({ double: { $ref: ["__#0"] } });
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript"
    );
    expect(nodes[0].inputs).toEqual({ $ref: ["x"] });
    expect(nodes[0].outputs).toEqual({ $ref: ["__#1"] });
    expect(nodes[1].inputs).toEqual({ $ref: ["__#1"] });
    expect(nodes[1].outputs).toEqual({ $ref: ["__#0"] });
  });

  it("work with path references", () => {
    const doubleRecipe = recipe<{ x: number }>("Double a number", ({ x }) => {
      (x as CellProxy<number>).setDefault(1);
      const double = lift<{ x: number }>(({ x }) => ({ doubled: x * 2 }));
      const result = double({ x });
      const result2 = double({ x: result.doubled });
      return { double: result2.doubled };
    });
    expect(isRecipe(doubleRecipe)).toBe(true);
    const { schema, initial, nodes } = doubleRecipe;
    expect(schema).toMatchObject({
      description: "Double a number",
      type: "object",
      properties: {
        double: { properties: { $ref: { type: "array" } } },
        x: { type: "integer", default: 1 },
      },
    });
    expect(initial).toEqual({ double: { $ref: ["__#0", "doubled"] } });
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript"
    );
    expect(nodes[0].inputs).toEqual({ x: { $ref: ["x"] } });
    expect(nodes[0].outputs).toEqual({ $ref: ["__#1"] });
    expect(nodes[1].inputs).toEqual({ x: { $ref: ["__#1", "doubled"] } });
    expect(nodes[1].outputs).toEqual({ $ref: ["__#0"] });
  });
});
