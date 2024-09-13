import { describe, it, expect } from "vitest";
import { recipe, lift } from "@commontools/common-builder";
import { run } from "../src/runner.js";
import { idle } from "../src/scheduler.js";

describe("Recipe Runner", () => {
  it("should run a simple recipe", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { result: doubled };
      }
    );

    const result = run(simpleRecipe, { value: 5 });

    await idle();

    expect(result.getAsProxy()).toMatchObject({ result: 10 });
  });

  it("should handle nested recipes", async () => {
    const innerRecipe = recipe<{ x: number }>("Inner Recipe", ({ x }) => {
      const squared = lift((n: number) => {
        return n * n;
      })(x);
      return { squared };
    });

    const outerRecipe = recipe<{ value: number }>(
      "Outer Recipe",
      ({ value }) => {
        const { squared } = innerRecipe({ x: value });
        const result = lift((n: number) => {
          return n + 1;
        })(squared);
        return { result };
      }
    );

    const result = run(outerRecipe, { value: 4 });

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

    const result1 = run(recipeWithDefaults, {});

    await idle();

    expect(result1.getAsProxy()).toMatchObject({ sum: 15 });

    const result2 = run(recipeWithDefaults, { a: 20 });

    await idle();

    expect(result2.getAsProxy()).toMatchObject({ sum: 30 });
  });

  it("should handle recipes with map nodes", async () => {
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

    const result = run(doubleArray, { values: [{ x: 1 }, { x: 2 }, { x: 3 }] });

    await idle();

    expect(result.getAsProxy()).toMatchObject({
      doubled: [{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }],
    });
  });
});
