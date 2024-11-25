import { describe, it, expect } from "vitest";
import { recipe, lift, handler, byRef } from "@commontools/common-builder";
import { run } from "../src/runner.js";
import { addModuleByRef } from "../src/module.js";
import { cell } from "../src/cell.js";
import { idle } from "../src/scheduler.js";

describe("Recipe Runner", () => {
  it("should run a simple recipe", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { result: doubled };
      },
    );

    console.log("simpleRecipe", JSON.stringify(simpleRecipe.toJSON(), null, 2));
    const result = run(simpleRecipe, { value: 5 });

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({ result: 10 });
  });

  it("should handle nested recipes", async () => {
    const innerRecipe = recipe<{ x: number }>("Inner Recipe", ({ x }) => {
      const squared = lift((n: number) => {
        console.log("inner squared", n);
        return n * n;
      })(x);
      return { squared };
    });

    const outerRecipe = recipe<{ value: number }>(
      "Outer Recipe",
      ({ value }) => {
        const { squared } = innerRecipe({ x: value });
        const result = lift((n: number) => {
          console.log("n", n);
          return n + 1;
        })(squared);
        return { result };
      },
    );

    console.log("outerRecipe", JSON.stringify(outerRecipe.toJSON(), null, 2));
    const result = run(outerRecipe, { value: 4 });
    console.log(
      "sourceCells",
      JSON.stringify(result.sourceCell?.getAsQueryResult(), null, 2),
    );

    await idle();
    console.log("result", JSON.stringify(result.getAsQueryResult(), null, 2));

    expect(result.getAsQueryResult()).toEqual({ result: 17 });
  });

  it("should handle recipes with default values", async () => {
    const recipeWithDefaults = recipe<{ a: number; b: number }>(
      "Recipe with Defaults",
      ({ a, b }) => {
        a.setDefault(5);
        b.setDefault(10);
        const { sum } = lift(({ x, y }) => ({ sum: x + y }))({ x: a, y: b });
        return { sum };
      },
    );

    const result1 = run(recipeWithDefaults, {});

    await idle();

    expect(result1.getAsQueryResult()).toMatchObject({ sum: 15 });

    const result2 = run(recipeWithDefaults, { a: 20 });

    await idle();

    expect(result2.getAsQueryResult()).toMatchObject({ sum: 30 });
  });

  it("should handle recipes with map nodes", async () => {
    const doubleArray = recipe<{ values: { x: number }[] }>(
      "Double numbers",
      ({ values }) => {
        const doubled = values.map(({ x }) => {
          const double = lift<number>((x) => x * 2);
          return { double: double(x) };
        });
        return { doubled };
      },
    );

    const result = run(doubleArray, { values: [{ x: 1 }, { x: 2 }, { x: 3 }] });

    await idle();

    // This is necessary to ensure the recipe has time to run
    // TODO: Get await idle() to work for this case as well
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(result.getAsQueryResult()).toMatchObject({
      doubled: [{ double: 2 }, { double: 4 }, { double: 6 }],
    });
  });

  it("should handle recipes with map nodes with closures", async () => {
    const double = lift<{ x: number; factor: number }>(
      ({ x, factor }) => x * factor,
    );

    const doubleArray = recipe<{ values: number[]; factor: number }>(
      "Double numbers",
      ({ values, factor }) => {
        const doubled = values.map((x) => double({ x, factor }));
        return { doubled };
      },
    );

    const result = run(doubleArray, {
      values: [1, 2, 3],
      factor: 3,
    });

    await idle();

    // This is necessary to ensure the recipe has time to run
    // TODO: Get await idle() to work for this case as well
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(result.getAsQueryResult()).toMatchObject({
      doubled: [3, 6, 9],
    });
  });

  it("should execute handlers", async () => {
    const incHandler = handler<
      { amount: number },
      { counter: { value: number } }
    >(({ amount }, { counter }) => {
      counter.value += amount;
    });

    const incRecipe = recipe<{ counter: { value: number } }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const result = run(incRecipe, { counter: { value: 0 } });

    await idle();

    result.asRendererCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 1 } });

    result.asRendererCell(["stream"]).send({ amount: 2 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 3 } });
  });

  it("should execute recipes returned by handlers", async () => {
    const counter = cell({ value: 0 });
    const nested = cell({ a: { b: { c: 0 } } });

    const values: [number, number, number][] = [];

    const incLogger = lift<{
      counter: { value: number };
      amount: number;
      nested: { c: number };
    }>(({ counter, amount, nested }) => {
      values.push([counter.value, amount, nested.c]);
    });

    let n = 0;
    const incHandler = handler<
      { amount: number },
      { counter: { value: number }; nested: { a: { b: { c: number } } } }
    >((event, { counter, nested }) => {
      counter.value += event.amount;
      return incLogger({ counter, amount: event.amount, nested: nested.a.b });
    });

    const incRecipe = recipe<{
      counter: { value: number };
      nested: { a: { b: { c: number } } };
    }>("event handler that returns a graph", ({ counter, nested }) => {
      const stream = incHandler({ counter, nested });
      return { stream };
    });

    const result = run(incRecipe, { counter, nested });

    await idle();

    result.asRendererCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(values).toEqual([[1, 1, 0]]);

    result.asRendererCell(["stream"]).send({ amount: 2 });
    await idle();
    expect(values).toEqual([
      [1, 1, 0],
      // Next is the first logger called again when counter changes, since this
      // is now a long running charmlet:
      [3, 1, 0],
      [3, 2, 0],
    ]);
  });

  it("should support referenced modules", async () => {
    addModuleByRef(
      "double",
      lift((x: number) => x * 2),
    );

    const double = byRef("double");

    const simpleRecipe = recipe<{ value: number }>(
      "Simple Recipe",
      ({ value }) => {
        const doubled = double(value);
        return { result: doubled };
      },
    );

    const result = run(simpleRecipe, { value: 5 });

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({ result: 10 });
  });
});
