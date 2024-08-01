import { describe, it, expect } from "vitest";
import { Recipe } from "../../src/builder/types.js";
import { runRecipe } from "../../src/runner/runner.js";
import { idle } from "../../src/runner/scheduler.js";

describe("runRecipe", () => {
  it("should work with passthrough", () => {
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

    const result = runRecipe(recipe, {});
    idle();
    expect(result.get()).toEqual({
      input: 1,
      output: 1,
    });
  });

  it("should work with nested recipes", () => {
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

    const result = runRecipe(outerRecipe, {});
    idle();
    expect(result.get()).toEqual({ value: 5, result: 5 });
  });

  it("should run a simple recipe", () => {
    const mockRecipe: Recipe = {
      schema: {},
      initial: { value: 1 },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const result = runRecipe(mockRecipe, {});
    idle();
    expect(result.get()).toEqual({ value: 2 });
  });

  it("should handle nested recipes", () => {
    const nestedRecipe: Recipe = {
      schema: {},
      initial: { value: 2 },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const mockRecipe: Recipe = {
      schema: {},
      initial: { value: 1 },
      nodes: [
        {
          module: { type: "recipe", implementation: nestedRecipe },
          inputs: { value: { $alias: ["value"] } },
          outputs: { value: { $alias: ["value"] } },
        },
      ],
    };

    const result = runRecipe(mockRecipe, {});
    idle();
    expect(result.get()).toEqual({ value: 4 });
  });
});
