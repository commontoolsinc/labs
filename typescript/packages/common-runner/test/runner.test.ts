import { describe, it, expect } from "vitest";
import { Recipe } from "@commontools/common-builder";
import { run, stop } from "../src/runner.js";
import { idle } from "../src/scheduler.js";
import { cell } from "../src/cell.js";

describe("runRecipe", () => {
  it("should work with passthrough", async () => {
    const recipe = {
      schema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
      },
      initial: { input: 1 },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { path: ["input"] } } },
          outputs: { value: { $alias: { path: ["output"] } } },
        },
      ],
    } as Recipe;

    const result = run(recipe, {});
    await idle();
    expect(result.get()).toMatchObject({
      input: 1,
      output: 1,
    });
  });

  it("should work with nested recipes", async () => {
    const innerRecipe = {
      schema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
      },
      initial: {},
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { path: ["input"] } } },
          outputs: { value: { $alias: { path: ["output"] } } },
        },
      ],
    } as Recipe;

    const outerRecipe = {
      schema: {
        type: "object",
        properties: {
          value: { type: "number" },
          result: { type: "number" },
        },
      },
      initial: { value: 5 },
      nodes: [
        {
          module: { type: "recipe", implementation: innerRecipe },
          inputs: { input: { $alias: { path: ["value"] } } },
          outputs: { output: { $alias: { path: ["result"] } } },
        },
      ],
    } as Recipe;

    const result = run(outerRecipe, {});
    await idle();
    expect(result.get()).toMatchObject({ value: 5, result: 5 });
  });

  it("should run a simple module", async () => {
    const mockRecipe: Recipe = {
      schema: {},
      initial: { value: 1 },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["value"] } },
          outputs: { $alias: { path: ["result"] } },
        },
      ],
    };

    const result = run(mockRecipe, {});
    await idle();
    expect(result.get()).toMatchObject({ value: 1, result: 2 });
  });

  it("should handle nested recipes", async () => {
    const nestedRecipe: Recipe = {
      schema: {},
      initial: {},
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["input"] } },
          outputs: { $alias: { path: ["output"] } },
        },
      ],
    };

    const mockRecipe: Recipe = {
      schema: {},
      initial: { value: 1 },
      nodes: [
        {
          module: { type: "recipe", implementation: nestedRecipe },
          inputs: { input: { $alias: { path: ["value"] } } },
          outputs: { output: { $alias: { path: ["result"] } } },
        },
      ],
    };

    const result = run(mockRecipe, {});
    await idle();
    expect(result.get()).toMatchObject({ value: 1, result: 2 });
  });

  it("should allow passing a cell as a binding", async () => {
    const recipe: Recipe = {
      schema: {},
      initial: {},
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["input"] } },
          outputs: { $alias: { path: ["output"] } },
        },
      ],
    };

    const inputCell = cell({ input: 10, output: 0 });
    const result = run(recipe, inputCell);

    await idle();

    expect(result.get()).toMatchObject({
      output: { $alias: { cell: inputCell, path: ["output"] } },
      input: { $alias: { cell: inputCell, path: ["input"] } },
    });
    expect(inputCell.get()).toMatchObject({ input: 10, output: 20 });
  });

  it("should allow stopping a recipe", async () => {
    const recipe: Recipe = {
      schema: {},
      initial: {},
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["input"] } },
          outputs: { $alias: { path: ["output"] } },
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
