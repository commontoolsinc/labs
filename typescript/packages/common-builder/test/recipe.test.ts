import { describe, it, expect } from "vitest";
import { Recipe, isRecipe, Module, isModule } from "../src/types.js";
import { lift } from "../src/module.js";
import { recipe } from "../src/recipe.js";

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

  it("has the correct schema and initial data", () => {
    expect(isRecipe(doubleRecipe)).toBe(true);
    expect(schema).toMatchObject({
      description: "Double a number",
      type: "object",
      properties: {
        double: {},
        x: { type: "integer", default: 1 },
      },
    });
    expect(initial).toEqual({ double: { $alias: { path: ["__#1"] } } });
  });

  it("has the correct nodes", () => {
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript"
    );
    expect(nodes[0].inputs).toEqual({ $alias: { path: ["x"] } });
    expect(nodes[0].outputs).toEqual({ $alias: { path: ["__#0"] } });
    expect(nodes[1].inputs).toEqual({ $alias: { path: ["__#0"] } });
    expect(nodes[1].outputs).toEqual({ $alias: { path: ["__#1"] } });
  });
});

describe("complex recipe with path aliases", () => {
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
        double: {},
        x: { type: "integer", default: 1 },
      },
    });
    expect(initial).toEqual({
      double: { $alias: { path: ["__#1", "doubled"] } },
    });
  });

  it("has the correct nodes", () => {
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript"
    );
    expect(nodes[0].inputs).toEqual({ x: { $alias: { path: ["x"] } } });
    expect(nodes[0].outputs).toEqual({ $alias: { path: ["__#0"] } });
    expect(nodes[1].inputs).toEqual({
      x: { $alias: { path: ["__#0", "doubled"] } },
    });
    expect(nodes[1].outputs).toEqual({ $alias: { path: ["__#1"] } });
  });

  it("correctly serializes to JSON", () => {
    const json = JSON.stringify(doubleRecipe);
    const parsed = JSON.parse(json);
    expect(json.length).toBeGreaterThan(200);
    expect(parsed.nodes[0].module.implementation).toContain(" => ");
  });
});

describe("recipe with map node", () => {
  const doubleArray = recipe<{ values: { x: number }[] }>(
    "Double numbers",
    ({ values }) => {
      const doubled = values.map(({ x }) => {
        const double = lift<number>((x) => x * 2);
        return { doubled: double(x) };
      });
      return { doubled };
    }
  );

  it("correctly serializes to a single map node", () => {
    expect(doubleArray.nodes.length).toBe(1);
    const module = doubleArray.nodes[0].module as Module;
    expect(module.type).toBe("ref");
    expect(module.implementation).toBe("map");
  });

  it("correctly lists the input array as input to the map node", () => {
    const node = doubleArray.nodes[0];
    expect(node.inputs).toMatchObject({
      list: { $alias: { path: ["values"] } },
    });
  });

  it("correctly lists the recipe as input to the map node", () => {
    const inputs = doubleArray.nodes[0].inputs as { op: Recipe };
    expect(isRecipe(inputs.op)).toBe(true);
  });

  it("correctly associated the code with the inner recipe", () => {
    const inputs = doubleArray.nodes[0].inputs as { op: Recipe };
    const module = inputs.op.nodes[0].module as Module;
    expect(module.type).toBe("javascript");
    expect(typeof module.implementation).toBe("function");
  });
});
