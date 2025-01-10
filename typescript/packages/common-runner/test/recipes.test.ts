import { describe, it, expect } from "vitest";
import {
  recipe,
  lift,
  handler,
  byRef,
  JSONSchema,
} from "@commontools/common-builder";
import { run } from "../src/runner.js";
import { addModuleByRef } from "../src/module.js";
import { cell, RendererCell } from "../src/cell.js";
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

    const result = run(simpleRecipe, { value: 5 });

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({ result: 10 });
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
      },
    );

    const result = run(outerRecipe, { value: 4 });

    await idle();

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
    const multipliedArray = recipe<{ values: { x: number }[] }>(
      "Multiply numbers",
      ({ values }) => {
        const multiplied = values.map(({ x }, index, array) => {
          const multiply = lift<number>(x => x * (index + 1) * array.length);
          return { multiplied: multiply(x) };
        });
        return { multiplied };
      },
    );

    const result = run(multipliedArray, {
      values: [{ x: 1 }, { x: 2 }, { x: 3 }],
    });

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({
      multiplied: [{ multiplied: 3 }, { multiplied: 12 }, { multiplied: 27 }],
    });
  });

  it("should handle recipes with map nodes with closures", async () => {
    const double = lift<{ x: number; factor: number }>(
      ({ x, factor }) => x * factor,
    );

    const doubleArray = recipe<{ values: number[]; factor: number }>(
      "Double numbers",
      ({ values, factor }) => {
        const doubled = values.map(x => double({ x, factor }));
        return { doubled };
      },
    );

    const result = run(doubleArray, {
      values: [1, 2, 3],
      factor: 3,
    });

    await idle();

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

  it("should execute handlers that use bind and this", async () => {
    // Switch to `function` so that we can set the type of `this`.
    const incHandler = handler<
      { amount: number },
      { counter: { value: number } }
    >(function ({ amount }) {
      this.counter.value += amount;
    });

    const incRecipe = recipe<{ counter: { value: number } }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler.bind({ counter }) };
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

  it("should execute handlers that use bind and this (no types)", async () => {
    // Switch to `function` so that we can set the type of `this`.
    const incHandler = handler(function ({ amount }) {
      this.counter.value += amount;
    });

    const incRecipe = recipe<{ counter: { value: number } }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler.bind({ counter }) };
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

  it("should handle recipes returned by lifted functions", async () => {
    const x = cell(2);
    const y = cell(3);

    const runCounts = {
      multiply: 0,
      multiplyGenerator: 0,
      multiplyGenerator2: 0,
    };

    const multiply = lift<{ x: number; y: number }>(({ x, y }) => {
      runCounts.multiply++;
      return x * y;
    });

    const multiplyGenerator = lift<{ x: number; y: number }>(args => {
      runCounts.multiplyGenerator++;
      return multiply(args);
    });

    const multiplyGenerator2 = lift<{ x: number; y: number }>(({ x, y }) => {
      runCounts.multiplyGenerator2++;
      // Now passing literals, so will hardcode values in recipe and hence
      // re-run when values change
      return multiply({ x, y });
    });

    const multiplyRecipe = recipe<{ x: number; y: number }>(
      "multiply",
      args => {
        return {
          result1: multiplyGenerator(args),
          result2: multiplyGenerator2(args),
        };
      },
    );

    const result = run(multiplyRecipe, { x, y });

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({
      result1: 6,
      result2: 6,
    });

    expect(runCounts).toMatchObject({
      multiply: 2,
      multiplyGenerator: 1,
      multiplyGenerator2: 1,
    });

    x.send(3);
    await idle();

    expect(runCounts).toMatchObject({
      multiply: 4,
      multiplyGenerator: 1, // Did not re-run, since we didn't read the values!
      multiplyGenerator2: 2,
    });

    expect(result.getAsQueryResult()).toMatchObject({
      result1: 9,
      result2: 9,
    });
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

  it("should handle schema with cell references", async () => {
    const schema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
        },
        multiplier: { type: "number" },
      },
    } as JSONSchema;

    const multiplyRecipe = recipe<{
      settings: { value: number };
      multiplier: number;
    }>("Multiply with Settings", ({ settings, multiplier }) => {
      const result = lift(
        schema,
        { type: "number" },
        ({ settings, multiplier }) => settings.value * multiplier,
      )({ settings, multiplier });
      return { result };
    });

    const settingsCell = cell({ value: 5 });
    const result = run(multiplyRecipe, {
      settings: settingsCell,
      multiplier: 3,
    });

    await idle();

    expect(result.getAsQueryResult()).toEqual({ result: 15 });

    // Update the cell and verify the recipe recomputes
    settingsCell.send({ value: 10 });

    await idle();

    expect(result.getAsQueryResult()).toEqual({ result: 30 });
  });

  it("should handle nested cell references in schema", async () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "number" },
                },
                asCell: true,
              },
            },
          },
        },
      },
    } as JSONSchema;

    const sumRecipe = recipe<{ data: { items: Array<{ value: number }> } }>(
      "Sum Items",
      ({ data }) => {
        const result = lift(schema, { type: "number" }, ({ data }) =>
          data.items.reduce((sum, item) => sum + item.get().value, 0),
        )({ data });
        return { result };
      },
    );

    const item1 = cell({ value: 1 });
    const item2 = cell({ value: 2 });
    const result = run(sumRecipe, { data: { items: [item1, item2] } });

    await idle();

    expect(result.getAsQueryResult()).toEqual({ result: 3 });
  });

  it("should handle dynamic cell references with schema", async () => {
    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: {
            type: "number",
            asCell: true,
          },
        },
      },
    } as JSONSchema;

    const dynamicRecipe = recipe<{ context: Record<string, number> }>(
      "Dynamic Context",
      ({ context }) => {
        const result = lift(schema, { type: "number" }, ({ context }) =>
          Object.values(context ?? {}).reduce(
            (sum: number, val) => sum + (val as RendererCell<number>).get(),
            0,
          ),
        )({ context });
        return { result };
      },
    );

    const value1 = cell(5);
    const value2 = cell(7);
    const result = run(dynamicRecipe, {
      context: {
        first: value1,
        second: value2,
      },
    });

    await idle();

    expect(result.getAsQueryResult()).toEqual({ result: 12 });
  });

  it("should execute handlers with schemas", async () => {
    const incHandler = handler<{ amount: number }, { counter: number }>(
      { type: "object", properties: { amount: { type: "number" } } },
      {
        type: "object",
        properties: {
          counter: {
            type: "number",
            asCell: true,
          },
        },
      },
      ({ amount }, { counter }) => {
        const counterCell = counter as unknown as RendererCell<number>;
        counterCell.send(counterCell.get() + amount);
      },
    );

    const incRecipe = recipe<{ counter: number }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const result = run(incRecipe, { counter: 0 });

    await idle();

    result.asRendererCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: 1 });

    result.asRendererCell(["stream"]).send({ amount: 2 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: 3 });
  });
});
