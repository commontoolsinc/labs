import { describe, it, expect } from "vitest";
import { Recipe } from "@commontools/common-builder";
import { run } from "../src/runner.js";
import { idle } from "../src/scheduler.js";

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
});
