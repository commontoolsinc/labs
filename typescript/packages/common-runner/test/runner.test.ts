import { describe, it, expect } from "vitest";
import { Recipe, TYPE } from "@commontools/common-builder";
import { run, stop } from "../src/runner.js";
import { idle } from "../src/scheduler.js";
import { cell } from "../src/cell.js";

describe("runRecipe", () => {
  it("should work with passthrough", async () => {
    const recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
        description: "passthrough",
      },
      resultSchema: {},
      result: { output: { $alias: { path: ["internal", "output"] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { path: ["argument", "input"] } } },
          outputs: { value: { $alias: { path: ["internal", "output"] } } },
        },
      ],
    } as Recipe;

    const result = run(recipe, { input: 1 });
    await idle();

    expect(result.sourceCell?.getAsQueryResult()).toMatchObject({
      argument: { input: 1 },
      internal: { output: 1 },
    });
    expect(result.sourceCell?.get().internal.output).toBe(1);
    expect(result.get()).toEqual({
      output: {
        $alias: { path: ["internal", "output"], cell: result.sourceCell },
      },
    });
    expect(result.getAsQueryResult()).toEqual({ output: 1 });
  });

  it("should work with nested recipes", async () => {
    const innerRecipe = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
      },
      resultSchema: {},
      result: { $alias: { cell: 1, path: ["internal", "output"] } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: {
            value: { $alias: { cell: 1, path: ["argument", "input"] } },
          },
          outputs: {
            value: { $alias: { cell: 1, path: ["internal", "output"] } },
          },
        },
      ],
    } as Recipe;

    const outerRecipe = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
          result: { type: "number" },
        },
      },
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "output"] } } },
      nodes: [
        {
          module: { type: "recipe", implementation: innerRecipe },
          inputs: { input: { $alias: { path: ["argument", "value"] } } },
          outputs: { $alias: { path: ["internal", "output"] } },
        },
      ],
    } as Recipe;

    const result = run(outerRecipe, { value: 5 });
    await idle();

    expect(result.getAsQueryResult()).toEqual({ result: 5 });
  });

  it("should run a simple module", async () => {
    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: { $alias: { path: ["internal", "result"] } },
        },
      ],
    };

    const result = run(mockRecipe, { value: 1 });
    await idle();
    expect(result.getAsQueryResult()).toEqual({ result: 2 });
  });

  it("should run a simple module with no outputs", async () => {
    let ran = false;

    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: {},
        },
      ],
    };

    const result = run(mockRecipe, { value: 1 });
    await idle();
    expect(result.getAsQueryResult()).toEqual({ result: undefined });
    expect(ran).toBe(true);
  });

  it("should handle incorrect inputs gracefully", async () => {
    let ran = false;

    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { path: ["argument", "other"] } },
          outputs: {},
        },
      ],
    };

    const result = run(mockRecipe, { value: 1 });
    await idle();
    expect(result.getAsQueryResult()).toEqual({ result: undefined });
    expect(ran).toBe(true);
  });

  it("should handle nested recipes", async () => {
    const nestedRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { $alias: { cell: 1, path: ["internal", "result"] } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: 1, path: ["argument", "input"] } },
          outputs: { $alias: { cell: 1, path: ["internal", "result"] } },
        },
      ],
    };

    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: { type: "recipe", implementation: nestedRecipe },
          inputs: { input: { $alias: { path: ["argument", "value"] } } },
          outputs: { $alias: { path: ["internal", "result"] } },
        },
      ],
    };

    const result = run(mockRecipe, { value: 1 });
    await idle();
    expect(result.getAsQueryResult()).toEqual({ result: 2 });
  });

  it("should allow passing a cell as a binding", async () => {
    const recipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { path: ["argument", "output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["argument", "input"] } },
          outputs: { $alias: { path: ["argument", "output"] } },
        },
      ],
    };

    const inputCell = cell({ input: 10, output: 0 });
    inputCell.generateEntityId();
    const result = run(recipe, inputCell);

    await idle();

    expect(inputCell.get()).toMatchObject({ input: 10, output: 20 });
    expect(result.getAsQueryResult()).toEqual({ output: 20 });

    // The result should alias the original cell. Let's verify by stopping the
    // recipe and sending a new value to the input cell.
    stop(result);
    inputCell.send({ input: 10, output: 40 });
    await idle();
    expect(result.getAsQueryResult()).toEqual({ output: 40 });
  });

  it("should allow stopping a recipe", async () => {
    const recipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { path: ["argument", "output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["argument", "input"] } },
          outputs: { $alias: { path: ["argument", "output"] } },
        },
      ],
    };

    const inputCell = cell({ input: 10, output: 0 });
    const result = run(recipe, inputCell);

    await idle();
    expect(inputCell.get()).toMatchObject({ input: 10, output: 20 });

    inputCell.send({ input: 20, output: 20 });
    await idle();
    expect(inputCell.get()).toMatchObject({ input: 20, output: 40 });

    // Stop the recipe
    stop(result);

    inputCell.send({ input: 40, output: 40 });
    await idle();
    expect(inputCell.get()).toMatchObject({ input: 40, output: 40 });

    // Restart the recipe
    run(recipe, undefined, result);

    await idle();
    expect(inputCell.get()).toMatchObject({ input: 40, output: 80 });
  });
});
