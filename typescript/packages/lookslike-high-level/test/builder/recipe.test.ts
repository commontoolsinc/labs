import { describe, it, expect } from "vitest";
import { isRecipe, isModule } from "../../src/builder/types.js";
import { lift } from "../../src/builder/module.js";
import { recipe } from "../../src/builder/recipe.js";

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
});

describe("complex recipe function", () => {
  const doubleRecipe = recipe<{ x: number }>("Double a number", ({ x }) => {
    x.setDefault(1);
    const double = lift<number>((x) => x * 2);
    return { double: double(double(x)) };
  });
  const { schema, initial, nodes } = doubleRecipe;

  it("is has the correct schema and initial data", () => {
    expect(isRecipe(doubleRecipe)).toBe(true);
    expect(schema).toMatchObject({
      description: "Double a number",
      type: "object",
      properties: {
        double: { properties: { $ref: { type: "array" } } },
        x: { type: "integer", default: 1 },
      },
    });
    expect(initial).toEqual({ double: { $ref: ["__#0"] } });
  });

  it("is has the correct nodes", () => {
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript"
    );
    expect(nodes[0].inputs).toEqual({ $ref: ["x"] });
    expect(nodes[0].outputs).toEqual({ $ref: ["__#1"] });
    expect(nodes[1].inputs).toEqual({ $ref: ["__#1"] });
    expect(nodes[1].outputs).toEqual({ $ref: ["__#0"] });
  });
});

describe("complex recipe with path references", () => {
  const doubleRecipe = recipe<{ x: number }>("Double a number", ({ x }) => {
    x.setDefault(1);
    const double = lift<{ x: number }>(({ x }) => ({ doubled: x * 2 }));
    const result = double({ x });
    const result2 = double({ x: result.doubled });
    return { double: result2.doubled };
  });
  const { schema, initial, nodes } = doubleRecipe;

  it("has the correct schema and initial values", () => {
    expect(isRecipe(doubleRecipe)).toBe(true);
    expect(schema).toMatchObject({
      description: "Double a number",
      type: "object",
      properties: {
        double: { properties: { $ref: { type: "array" } } },
        x: { type: "integer", default: 1 },
      },
    });
    expect(initial).toEqual({ double: { $ref: ["__#0", "doubled"] } });
  });

  it("has the correct nodes", () => {
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript"
    );
    expect(nodes[0].inputs).toEqual({ x: { $ref: ["x"] } });
    expect(nodes[0].outputs).toEqual({ $ref: ["__#1"] });
    expect(nodes[1].inputs).toEqual({ x: { $ref: ["__#1", "doubled"] } });
    expect(nodes[1].outputs).toEqual({ $ref: ["__#0"] });
  });

  it("correctly serializes to JSON", () => {
    const json = JSON.stringify(doubleRecipe);
    const parsed = JSON.parse(json);
    expect(json.length).toBeGreaterThan(200);
    expect(parsed.nodes[0].module.implementation).toContain(" => ");
  });
});
