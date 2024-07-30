import { describe, it, expect } from "vitest";
import { Recipe } from "../../src/builder/types.js";
import {
  runRecipe,
  extractDefaultValues,
  mergeObjects,
  sendValueToBinding,
  mapBindingsToCell,
} from "../../src/runner/runner.js";
import { cell } from "../../src/runner/cell.js";

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
          inputs: { value: { $ref: { path: ["input"] } } },
          outputs: { value: { $ref: { path: ["output"] } } },
        },
      ],
    } as Recipe;

    const result = runRecipe(recipe, {});
    expect(result.get()).toEqual({
      input: 1,
      output: { $ref: { path: ["input"] } },
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
          inputs: { value: { $ref: { path: ["input"] } } },
          outputs: { value: { $ref: { path: ["output"] } } },
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
          inputs: { input: { $ref: { path: ["value"] } } },
          outputs: { output: { $ref: { path: ["result"] } } },
        },
      ],
    } as Recipe;

    const result = runRecipe(outerRecipe, {});
    expect(result.get()).toEqual({ value: 5, result: 5 });
  });
  /*
  it("should run a simple recipe", () => {
    const mockRecipe: Recipe = {
      schema: {},
      initial: { value: 1 },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (cell) => cell.value.set(cell.value.get() * 2),
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const result = runRecipe(mockRecipe, {});
    expect(result.export().value).toEqual({ value: 2 });
  });

  it("should handle nested recipes", () => {
    const nestedRecipe: Recipe = {
      schema: {},
      initial: { value: 2 },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (cell) => cell.value.set(cell.value.get() * 2),
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
          inputs: { value: { $ref: ["value"] } },
          outputs: { value: { $ref: ["value"] } },
        },
      ],
    };

    const result = runRecipe(mockRecipe, {});
    expect(result.export().value).toEqual({ value: 4 });
  });
  */
});
