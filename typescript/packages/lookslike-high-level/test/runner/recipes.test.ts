import { describe, it, expect } from "vitest";
import { recipe, lift } from "../../src/builder/index.js";
import { runRecipe } from "../../src/runner/runner.js";
import { idle } from "../../src/runner/scheduler.js";

describe("Recipe Runner", () => {
  it("should run a simple recipe", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { result: doubled };
      }
    );

    const result = runRecipe(simpleRecipe, { value: 5 });

    await idle();

    expect(result.getAsProxy()).toMatchObject({ result: 10 });
  });

  it("should handle nested recipes", async () => {
    const innerRecipe = recipe<{ x: number }>("Inner Recipe", ({ x }) => {
      const squared = lift((n: number) => {
        console.log("square", n);
        return n * n;
      })(x);
      return { squared };
    });

    const outerRecipe = recipe<{ value: number }>(
      "Outer Recipe",
      ({ value }) => {
        const { squared } = innerRecipe({ x: value });
        const result = lift((n: number) => {
          console.log("inc", n);
          return n + 1;
        })(squared);
        return { result };
      }
    );

    console.log("serialized", JSON.stringify(outerRecipe.toJSON(), null, 2));

    const result = runRecipe(outerRecipe, { value: 4 });

    await idle();

    expect(result.getAsProxy()).toMatchObject({ result: 17 });
  });

  it("should handle recipes with default values", async () => {
    const recipeWithDefaults = recipe<{ a: number; b: number }>(
      "Recipe with Defaults",
      ({ a, b }) => {
        a.setDefault(5);
        b.setDefault(10);
        const { sum } = lift(({ x, y }) => ({ sum: x + y }))({ x: a, y: b });
        return { sum };
      }
    );

    const result1 = runRecipe(recipeWithDefaults, {});

    await idle();

    expect(result1.getAsProxy()).toMatchObject({ sum: 15 });

    const result2 = runRecipe(recipeWithDefaults, { a: 20 });

    await idle();

    expect(result2.getAsProxy()).toMatchObject({ sum: 30 });
  });
});
