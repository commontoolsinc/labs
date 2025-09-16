import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isModule,
  isRecipe,
  type JSONSchema,
  type Module,
  type Recipe,
} from "../src/builder/types.ts";
import { lift } from "../src/builder/module.ts";
import { recipe } from "../src/builder/recipe.ts";
import { opaqueRef } from "../src/builder/opaque-ref.ts";

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

  it("creates a recipe, with an inner opaque ref", () => {
    const doubleRecipe = recipe<{ x: number }>("Double a number", () => {
      const x = opaqueRef<number>(1);
      x.setName("x");
      const double = lift(({ x }) => x * 2);
      return { double: double({ x }) };
    });
    expect(isRecipe(doubleRecipe)).toBe(true);
    expect(doubleRecipe.nodes[0].inputs).toEqual({
      x: { $alias: { path: ["internal", "x"] } },
    });
  });
});

describe("complex recipe function", () => {
  const doubleRecipe = recipe<{ x: number }>("Double a number", ({ x }) => {
    x.setDefault(1);
    const double = lift<number>((x) => x * 2);
    return { double: double(double(x)) };
  });
  const { argumentSchema, result, nodes } = doubleRecipe;

  it("has the correct schema and initial data", () => {
    expect(isRecipe(doubleRecipe)).toBe(true);
    expect(argumentSchema).toMatchObject({
      description: "Double a number",
      type: "object",
      properties: {
        x: { type: "integer", default: 1 },
      },
    });
    expect(result).toEqual({
      double: { $alias: { path: ["internal", "double"] } },
    });
  });

  it("has the correct nodes", () => {
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({ $alias: { path: ["argument", "x"] } });
    expect(nodes[0].outputs).toEqual({
      $alias: { path: ["internal", "defaultValue"] },
    });
    expect(nodes[1].inputs).toEqual({
      $alias: { path: ["internal", "defaultValue"] },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: { path: ["internal", "double"] },
    });
  });
});

describe("schemas", () => {
  it("supports JSON Schema with descriptions", () => {
    const makeRecipeWithSchemas = () => {
      const schema = {
        type: "object",
        properties: {
          x: { type: "number" },
        },
        description: "A number",
      } as const satisfies JSONSchema;

      return recipe<{ x: number }>(schema, ({ x }) => ({ x }));
    };

    const testRecipe = makeRecipeWithSchemas();
    expect(isRecipe(testRecipe)).toBe(true);
    expect(testRecipe.argumentSchema).toMatchObject({
      description: "A number",
      type: "object",
      properties: {
        x: { type: "number" },
      },
    });
  });

  it("works with JSON Schema in lifted functions", () => {
    const inputSchema = {
      type: "number",
      description: "A number",
    } as const satisfies JSONSchema;

    const outputSchema = {
      type: "number",
      description: "Doubled",
    } as const satisfies JSONSchema;

    const double = lift(
      inputSchema,
      outputSchema,
      (x: number) => x * 2,
    );

    const recipeInputSchema = {
      type: "object",
      properties: {
        x: { type: "number" },
      },
    } as const satisfies JSONSchema;

    const testRecipe = recipe<{ x: number }>(recipeInputSchema, ({ x }) => ({
      doubled: double(x),
    }));

    const module = testRecipe.nodes[0].module as Module;
    expect(module.argumentSchema).toMatchObject({
      description: "A number",
      type: "number",
    });
    expect(module.resultSchema).toMatchObject({
      description: "Doubled",
      type: "number",
    });
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
  const { argumentSchema, result, nodes } = doubleRecipe;

  it("has the correct schema and initial values", () => {
    expect(isRecipe(doubleRecipe)).toBe(true);
    expect(argumentSchema).toMatchObject({
      description: "Double a number",
      type: "object",
      properties: {
        x: { type: "integer", default: 1 },
      },
    });
    expect(result).toEqual({
      double: { $alias: { path: ["internal", "__#1", "doubled"] } },
    });
  });

  it("has the correct nodes", () => {
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({
      x: { $alias: { path: ["argument", "x"] } },
    });
    expect(nodes[0].outputs).toEqual({
      $alias: { path: ["internal", "__#0"] },
    });
    expect(nodes[1].inputs).toEqual({
      x: { $alias: { path: ["internal", "__#0", "doubled"] } },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: { path: ["internal", "__#1"] },
    });
  });

  it("correctly serializes to JSON", () => {
    const json = JSON.stringify(doubleRecipe);
    const parsed = JSON.parse(json);
    expect(json.length).toBeGreaterThan(200);
    expect(parsed.nodes[0].module.implementation).toContain("=>");
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
    },
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
      list: { $alias: { path: ["argument", "values"] } },
    });
  });

  it("correctly lists the recipe as input to the map node", () => {
    const inputs = doubleArray.nodes[0].inputs as unknown as { op: Recipe };
    expect(isRecipe(inputs.op)).toBe(true);
  });

  it("correctly associated the code with the inner recipe", () => {
    const inputs = doubleArray.nodes[0].inputs as unknown as { op: Recipe };
    const module = inputs.op.nodes[0].module as Module;
    expect(module.type).toBe("javascript");
    expect(typeof module.implementation).toBe("function");
  });
});

describe("recipe with map node that references a parent cell", () => {
  const multiplyArray = recipe<{ values: { x: number }[]; factor: number }>(
    "Double numbers",
    ({ values, factor }) => {
      const doubled = values.map(({ x }) => {
        const double = lift<{ x: number; factor: number }>(({ x, factor }) => ({
          x: x * factor,
        }));
        return { doubled: double({ x, factor }) };
      });
      return { doubled };
    },
  );

  it("correctly creates references to the parent cells", () => {
    expect(
      (multiplyArray.nodes[0].inputs as unknown as { op: Recipe }).op
        .nodes[0].inputs,
    ).toEqual({
      x: { $alias: { cell: 1, path: ["argument", "element", "x"] } },
      factor: { $alias: { path: ["argument", "factor"] } },
    });
  });
});

describe("recipe with map node that references a parent cell in another recipe", () => {
  it("correctly creates references to the parent cells", () => {
    const multiplyArray = recipe<{ values: { x: number }[] }>(
      "Double numbers",
      ({ values }) => {
        const wrapper = recipe("Wrapper", () => {
          const multiplied = values.map(({ x }, index) => {
            const multiply = lift<{ x: number; factor: number }>((
              { x, factor },
            ) => ({
              x: x * factor,
            }));
            return { multiplied: multiply({ x, factor: index }) };
          });
          return { multiplied };
        });
        return wrapper({ values });
      },
    );

    const subRecipe = (multiplyArray.nodes[0].module as Module)
      .implementation as Recipe;
    expect(isRecipe(subRecipe)).toBeTruthy();
    const subSubRecipe =
      (subRecipe.nodes[0].inputs as unknown as { op: Recipe })
        .op;
    expect(isRecipe(subSubRecipe)).toBeTruthy();
    expect(subSubRecipe.nodes[0].inputs).toEqual({
      x: { $alias: { cell: 2, path: ["argument", "element", "x"] } },
      factor: { $alias: { cell: 2, path: ["argument", "index"] } },
    });
  });
});

describe("recipe with ifc property", () => {
  const ArgumentSchema = {
    description: "Double a number",
    type: "object",
    properties: {
      x: {
        type: "integer",
        default: 1,
        ifc: { classification: ["confidential"] },
      },
    },
    required: ["x"],
  } as const satisfies JSONSchema;
  const ResultSchema = {
    description: "Doubled number",
    type: "object",
    properties: {
      double: {
        type: "integer",
        default: 1,
      },
    },
    required: ["double"],
  } as const satisfies JSONSchema;

  const double = lift<JSONSchema, JSONSchema>(
    ArgumentSchema,
    ResultSchema,
    ({ x }) => ({
      double: x * 2,
    }),
  );

  const doubleRecipe = recipe<{ x: number }, { double: number }>(
    ArgumentSchema,
    ResultSchema,
    ({ x }) => {
      x.setDefault(1);
      const result = double({ x });
      const result2 = double({ x: result.double });
      return { double: result2.double };
    },
  );
  const { result, nodes, argumentSchema } = doubleRecipe;

  it("has the correct schema and initial values", () => {
    expect(isRecipe(doubleRecipe)).toBe(true);
    expect(argumentSchema).toMatchObject(ArgumentSchema);
  });

  // It would be nice if we also had the {"type": "integer"} for the schema
  // The lifted function knows this in the result schema
  it("has the correct classification in the schema of the result", () => {
    expect(result).toEqual({
      double: {
        $alias: {
          path: ["internal", "__#1", "double"],
          schema: {
            ifc: ArgumentSchema.properties.x.ifc,
          },
        },
      },
    });
  });

  it("has the correct nodes", () => {
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({
      x: {
        $alias: {
          path: ["argument", "x"],
          rootSchema: ArgumentSchema,
          schema: ArgumentSchema.properties?.x,
        },
      },
    });
    // I don't like that we don't know the other properties of our output here
    expect(nodes[0].outputs).toEqual({
      $alias: {
        path: ["internal", "__#0"],
        schema: { ifc: ArgumentSchema.properties.x.ifc },
      },
    });
    expect(nodes[1].inputs).toEqual({
      x: {
        $alias: {
          path: ["internal", "__#0", "double"],
          schema: {
            ifc: ArgumentSchema.properties.x.ifc,
          },
        },
      },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: {
        path: ["internal", "__#1"],
        schema: {
          ifc: ArgumentSchema.properties.x.ifc,
        },
      },
    });
  });
});

describe("recipe with mixed ifc properties", () => {
  const ArgumentSchema = {
    description: "Capitalize a word",
    type: "object",
    properties: {
      word: {
        type: "string",
        default: "hello",
      },
    },
    required: ["word"],
  } as const satisfies JSONSchema;
  const ResultSchema = {
    description: "Capitalized word",
    type: "object",
    properties: {
      capitalized: {
        type: "string",
        default: "Hello",
      },
    },
    required: ["capitalized"],
  } as const satisfies JSONSchema;

  const capitalize = lift<JSONSchema, JSONSchema>(
    ArgumentSchema,
    ResultSchema,
    ({ word }) => ({
      capitalized: word.charAt(0).toUpperCase() + word.slice(1),
    }),
  );

  const UserSchema = {
    description: "Capitalize a word",
    type: "object",
    properties: {
      name: {
        type: "string",
        default: "hello",
      },
      ssn: {
        type: "string",
        default: "123-45-6789",
        ifc: { classification: ["confidential"] },
      },
    },
    required: ["word"],
  } as const satisfies JSONSchema;

  const capitalizeSsnRecipe = recipe<
    { ssn: string },
    { capitalized: string }
  >(
    UserSchema,
    ResultSchema,
    ({ ssn }) => {
      const result = capitalize({ ssn });
      return { capitalized: result.capitalized };
    },
  );

  it("has the correct classification in the schema of the ssn result", () => {
    const { result, nodes, argumentSchema, resultSchema } = capitalizeSsnRecipe;
    expect(isRecipe(capitalizeSsnRecipe)).toBe(true);
    expect(argumentSchema).toMatchObject(UserSchema);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].outputs).toHaveProperty("$alias");
    const nodeOutputAlias = (nodes[0].outputs as any)["$alias"];
    expect(nodeOutputAlias).toEqual({
      path: ["internal", "__#0"],
      schema: { ifc: { classification: ["confidential"] } },
    });
    expect(result).toEqual({
      capitalized: {
        $alias: {
          path: ["internal", "__#0", "capitalized"],
          schema: { ifc: { classification: ["confidential"] } },
        },
      },
    });
    expect(resultSchema).toEqual({
      ...ResultSchema,
      ...{ ifc: { classification: ["confidential"] } },
    });
  });

  // Perhaps I should handle a similar recipe that only accesses the name
  // in such a way that it does not end up classified. For now, I've decided
  // not to do this, since I'm not confident enough that code can't get out.
});
