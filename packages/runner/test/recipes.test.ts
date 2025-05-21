import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { byRef, handler, JSONSchema, lift, recipe } from "@commontools/builder";
import { run } from "../src/runner.ts";
import { addModuleByRef } from "../src/module.ts";
import { getDoc } from "../src/doc.ts";
import { type ErrorWithContext, idle, onError } from "../src/scheduler.ts";
import { type Cell } from "../src/cell.ts";
import { getRecipeIdFromCharm } from "../../charm/src/manager.ts";

describe("Recipe Runner", () => {
  it("should run a simple recipe", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { result: doubled };
      },
    );

    const result = run(
      simpleRecipe,
      { value: 5 },
      getDoc(undefined, "should run a simple recipe", "test"),
    );

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

    const result = run(
      outerRecipe,
      { value: 4 },
      getDoc(undefined, "should handle nested recipes", "test"),
    );

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

    const result1 = run(
      recipeWithDefaults,
      {},
      getDoc(
        undefined,
        "should handle recipes with defaults",
        "test",
      ),
    );

    await idle();

    expect(result1.getAsQueryResult()).toMatchObject({ sum: 15 });

    const result2 = run(
      recipeWithDefaults,
      { a: 20 },
      getDoc(
        undefined,
        "should handle recipes with defaults (2)",
        "test",
      ),
    );

    await idle();

    expect(result2.getAsQueryResult()).toMatchObject({ sum: 30 });
  });

  it("should handle recipes with map nodes", async () => {
    const multipliedArray = recipe<{ values: { x: number }[] }>(
      "Multiply numbers",
      ({ values }) => {
        const multiplied = values.map(({ x }, index, array) => {
          const multiply = lift<number>((x) => x * (index + 1) * array.length);
          return { multiplied: multiply(x) };
        });
        return { multiplied };
      },
    );

    const result = run(
      multipliedArray,
      {
        values: [{ x: 1 }, { x: 2 }, { x: 3 }],
      },
      getDoc(
        undefined,
        "should handle recipes with map nodes",
        "test",
      ),
    );

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({
      multiplied: [{ multiplied: 3 }, { multiplied: 12 }, { multiplied: 27 }],
    });
  });

  it("should handle recipes with map nodes with closures", async () => {
    const double = lift<{ x: number; factor: number }>(({ x, factor }) =>
      x * factor
    );

    const doubleArray = recipe<{ values: number[]; factor: number }>(
      "Double numbers",
      ({ values, factor }) => {
        const doubled = values.map((x) => double({ x, factor }));
        return { doubled };
      },
    );

    const result = run(
      doubleArray,
      {
        values: [1, 2, 3],
        factor: 3,
      },
      getDoc(
        undefined,
        "should handle recipes with map nodes with closures",
        "test",
      ),
    );

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({
      doubled: [3, 6, 9],
    });
  });

  it("should handle map nodes with undefined input", async () => {
    const double = lift((x: number) => x * 2);

    const doubleArray = recipe<{ values?: number[] }>(
      "Double numbers maybe undefined",
      ({ values }) => {
        const doubled = values.map((x) => double(x));
        return { doubled };
      },
    );

    const result = run(
      doubleArray,
      { values: undefined },
      getDoc(
        undefined,
        "should handle map nodes with undefined input",
        "test",
      ),
    );

    await idle();

    expect(result.getAsQueryResult()).toMatchObject({ doubled: [] });
  });

  it("should execute handlers", async () => {
    const incHandler = handler<
      { amount: number },
      { counter: { value: number } }
    >(
      ({ amount }, { counter }) => {
        counter.value += amount;
      },
    );

    const incRecipe = recipe<{ counter: { value: number } }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const result = run(
      incRecipe,
      { counter: { value: 0 } },
      getDoc(undefined, "should execute handlers", "test"),
    );

    await idle();

    result.asCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 1 } });

    result.asCell(["stream"]).send({ amount: 2 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 3 } });
  });

  it("should execute handlers that use bind and this", async () => {
    // Switch to `function` so that we can set the type of `this`.
    const incHandler = handler<
      { amount: number },
      { counter: { value: number } }
    >(function (
      this: { counter: { value: number } },
      { amount },
    ) {
      this.counter.value += amount;
    });

    const incRecipe = recipe<{ counter: { value: number } }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler.bind({ counter }) };
      },
    );

    const result = run(
      incRecipe,
      { counter: { value: 0 } },
      getDoc(
        undefined,
        "should execute handlers that use bind and this",
        "test",
      ),
    );

    await idle();

    result.asCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 1 } });

    result.asCell(["stream"]).send({ amount: 2 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 3 } });
  });

  it("should execute handlers that use bind and this (no types)", async () => {
    // Switch to `function` so that we can set the type of `this`.
    const incHandler = handler(
      function (this: { counter: { value: number } }, { amount }) {
        this.counter.value += amount;
      },
    );

    const incRecipe = recipe<{ counter: { value: number } }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler.bind({ counter }) };
      },
    );

    const result = run(
      incRecipe,
      { counter: { value: 0 } },
      getDoc(
        undefined,
        "should execute handlers that use bind and this (no types)",
        "test",
      ),
    );

    await idle();

    result.asCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 1 } });

    result.asCell(["stream"]).send({ amount: 2 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 3 } });
  });

  it("should execute recipes returned by handlers", async () => {
    const counter = getDoc(
      { value: 0 },
      "should execute recipes returned by handlers 1",
      "test",
    );
    const nested = getDoc(
      { a: { b: { c: 0 } } },
      "should execute recipes returned by handlers 2",
      "test",
    );

    const values: [number, number, number][] = [];

    const incLogger = lift<{
      counter: { value: number };
      amount: number;
      nested: { c: number };
    }>(({ counter, amount, nested }) => {
      values.push([counter.value, amount, nested.c]);
    });

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

    const result = run(
      incRecipe,
      { counter, nested },
      getDoc(
        undefined,
        "should execute recipes returned by handlers",
        "test",
      ),
    );

    await idle();

    result.asCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(values).toEqual([[1, 1, 0]]);

    result.asCell(["stream"]).send({ amount: 2 });
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
    const x = getDoc(
      2,
      "should handle recipes returned by lifted functions 1",
      "test",
    );
    const y = getDoc(
      3,
      "should handle recipes returned by lifted functions 2",
      "test",
    );

    const runCounts = {
      multiply: 0,
      multiplyGenerator: 0,
      multiplyGenerator2: 0,
    };

    const multiply = lift<{ x: number; y: number }>(({ x, y }) => {
      runCounts.multiply++;
      return x * y;
    });

    const multiplyGenerator = lift<{ x: number; y: number }>((args) => {
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
      (args) => {
        return {
          result1: multiplyGenerator(args),
          result2: multiplyGenerator2(args),
        };
      },
    );

    const result = run(
      multiplyRecipe,
      { x, y },
      getDoc(
        undefined,
        "should handle recipes returned by lifted functions",
        "test",
      ),
    );

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

    const result = run(
      simpleRecipe,
      { value: 5 },
      getDoc(undefined, "should support referenced modules", "test"),
    );

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
          required: ["value"],
        },
        multiplier: { type: "number" },
      },
      required: ["settings"],
    } as const satisfies JSONSchema;

    const multiplyRecipe = recipe<{
      settings: { value: number };
      multiplier: number;
    }>("Multiply with Settings", ({ settings, multiplier }) => {
      const result = lift(
        schema,
        { type: "number" },
        ({ settings, multiplier }) => settings.value * multiplier!,
      )({ settings, multiplier });
      return { result };
    });

    const settingsCell = getDoc(
      { value: 5 },
      "should handle schema with cell references 1",
      "test",
    );
    const result = run(
      multiplyRecipe,
      {
        settings: settingsCell,
        multiplier: 3,
      },
      getDoc(
        undefined,
        "should handle schema with cell references",
        "test",
      ),
    );

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
          required: ["items"],
        },
      },
      required: ["data"],
    } as const satisfies JSONSchema;

    const sumRecipe = recipe<{ data: { items: Array<{ value: number }> } }>(
      "Sum Items",
      ({ data }) => {
        const result = lift(
          schema,
          { type: "number" },
          ({ data }) =>
            data.items.reduce(
              (sum: number, item: any) => sum + item.get().value,
              0,
            ),
        )({ data });
        return { result };
      },
    );

    const item1 = getDoc(
      { value: 1 },
      "should handle nested cell references in schema 1",
      "test",
    );
    const item2 = getDoc(
      { value: 2 },
      "should handle nested cell references in schema 2",
      "test",
    );
    const result = run(
      sumRecipe,
      { data: { items: [item1, item2] } },
      getDoc(
        undefined,
        "should handle nested cell references in schema",
        "test",
      ),
    );

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
    } as const satisfies JSONSchema;

    const dynamicRecipe = recipe<{ context: Record<PropertyKey, number> }>(
      "Dynamic Context",
      ({ context }) => {
        const result = lift(
          schema,
          { type: "number" },
          ({ context }) =>
            Object.values(context ?? {}).reduce(
              (sum: number, val) => sum + (val as Cell<number>).get(),
              0,
            ),
        )({ context });
        return { result };
      },
    );

    const value1 = getDoc(
      5,
      "should handle dynamic cell references with schema 1",
      "test",
    );
    const value2 = getDoc(
      7,
      "should handle dynamic cell references with schema 2",
      "test",
    );
    const result = run(
      dynamicRecipe,
      {
        context: {
          first: value1,
          second: value2,
        },
      },
      getDoc(
        undefined,
        "should handle dynamic cell references with schema",
        "test",
      ),
    );

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
        const counterCell = counter as unknown as Cell<number>;
        counterCell.send(counterCell.get() + amount);
      },
    );

    const incRecipe = recipe<{ counter: number }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const result = run(
      incRecipe,
      { counter: 0 },
      getDoc(
        undefined,
        "should execute handlers with schemas",
        "test",
      ),
    );

    await idle();

    result.asCell(["stream"]).send({ amount: 1 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: 1 });

    result.asCell(["stream"]).send({ amount: 2 });
    await idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: 3 });
  });

  it("failed handlers should be ignored", async () => {
    let errors = 0;
    let lastError: ErrorWithContext | undefined;

    onError((error: ErrorWithContext) => {
      lastError = error;
      errors++;
    });

    const divHandler = handler<
      { divisor: number; dividend: number },
      { result: number }
    >(
      ({ divisor, dividend }, state) => {
        if (dividend === 0) {
          throw new Error("division by zero");
        }
        state.result = divisor / dividend;
      },
    );

    const divRecipe = recipe<{ result: number }>(
      "Divide numbers",
      ({ result }) => {
        return { updater: divHandler({ result }), result };
      },
    );

    const charm = run(
      divRecipe,
      { result: 1 },
      getDoc(undefined, "failed handlers should be ignored", "test"),
    );

    await idle();

    charm.asCell(["updater"]).send({ divisor: 5, dividend: 1 });
    await idle();
    expect(errors).toBe(0);

    expect(charm.getAsQueryResult()).toMatchObject({ result: 5 });

    charm.asCell(["updater"]).send({ divisor: 10, dividend: 0 });
    await idle();
    expect(errors).toBe(1);
    expect(charm.getAsQueryResult()).toMatchObject({ result: 5 });

    expect(lastError?.recipeId).toBe(getRecipeIdFromCharm(charm.asCell()));
    expect(lastError?.space).toBe("test");
    expect(lastError?.charmId).toBe(
      JSON.parse(JSON.stringify(charm.entityId))["/"],
    );

    // NOTE(ja): this test is really important after a handler
    // fails the entire system crashes!!!!
    charm.asCell(["updater"]).send({ divisor: 10, dividend: 5 });
    await idle();
    expect(charm.getAsQueryResult()).toMatchObject({ result: 2 });
  });

  it("failed lifted functions should be ignored", async () => {
    let errors = 0;
    let lastError: ErrorWithContext | undefined;

    onError((error: ErrorWithContext) => {
      lastError = error;
      errors++;
    });

    const divider = lift<
      { divisor: number; dividend: number },
      number
    >(
      ({ divisor, dividend }) => {
        if (dividend === 0) {
          throw new Error("division by zero");
        }
        return divisor / dividend;
      },
    );

    const divRecipe = recipe<{ divisor: number; dividend: number }>(
      "Divide numbers",
      ({ divisor, dividend }) => {
        return { result: divider({ divisor, dividend }) };
      },
    );

    const dividend = getDoc(
      1,
      "failed lifted functions should be ignored 1",
      "test",
    );

    const charm = run(
      divRecipe,
      { divisor: 10, dividend },
      getDoc(undefined, "failed lifted handlers should be ignored", "test"),
    );

    await idle();

    expect(errors).toBe(0);
    expect(charm.getAsQueryResult()).toMatchObject({ result: 10 });

    dividend.send(0);
    await idle();
    expect(errors).toBe(1);
    expect(charm.getAsQueryResult()).toMatchObject({ result: 10 });

    expect(lastError?.recipeId).toBe(getRecipeIdFromCharm(charm.asCell()));
    expect(lastError?.space).toBe("test");
    expect(lastError?.charmId).toBe(
      JSON.parse(JSON.stringify(charm.entityId))["/"],
    );

    // Make sure it recovers:
    dividend.send(2);
    await idle();
    expect((charm.get() as any).result.$alias.cell).toBe(charm.sourceCell);
    expect(charm.getAsQueryResult()).toMatchObject({ result: 5 });
  });

  it("idle should wait for slow async lifted functions", async () => {
    let liftCalled = false;
    let timeoutCalled = false;

    const slowLift = lift<{ x: number }, number>(({ x }) => {
      liftCalled = true;
      return new Promise((resolve) =>
        setTimeout(() => {
          timeoutCalled = true;
          resolve(x * 2);
        }, 100)
      ) as unknown as number;
      // Cast is a hack, because we don't actually want lift to be async as API.
      // This is just temporary support.
    });

    const slowRecipe = recipe<{ x: number }>(
      "Slow Recipe",
      ({ x }) => {
        return { result: slowLift({ x }) };
      },
    );

    const result = run(
      slowRecipe,
      { x: 1 },
      getDoc(
        undefined,
        "idle should wait for slow async lifted functions",
        "test",
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(liftCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    await idle();
    expect(timeoutCalled).toBe(true);
    expect(result.asCell().get()).toMatchObject({ result: 2 });
  });

  it("idle should wait for slow async handlers", async () => {
    let handlerCalled = false;
    let timeoutCalled = false;

    const slowHandler = handler<{ value: number }, { result: number }>(
      ({ value }, state) => {
        handlerCalled = true;
        // Using Promise to simulate an async operation
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            timeoutCalled = true;
            state.result = value * 2;
            resolve();
          }, 100)
        );
      },
    );

    const slowHandlerRecipe = recipe<{ result: number }>(
      "Slow Handler Recipe",
      ({ result }) => {
        return { result, updater: slowHandler({ result }) };
      },
    );

    const charm = run(
      slowHandlerRecipe,
      { result: 0 },
      getDoc(
        undefined,
        "idle should wait for slow async handlers",
        "test",
      ),
    );

    await idle();

    // Trigger the handler
    charm.asCell(["updater"]).send({ value: 5 });

    // Give a small delay to start the handler but not enough to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    // Now idle should wait for the handler's promise to resolve
    await idle();
    expect(timeoutCalled).toBe(true);
    expect(charm.asCell().get()).toMatchObject({ result: 10 });
  });

  it("idle should not wait for deliberately async handlers", async () => {
    let handlerCalled = false;
    let timeoutCalled = false;
    let timeoutPromise: Promise<void> | undefined;

    const slowHandler = handler<{ value: number }, { result: number }>(
      ({ value }, state) => {
        handlerCalled = true;
        // Capturing the promise, but _not_ returning it.
        timeoutPromise = new Promise<void>((resolve) =>
          setTimeout(() => {
            timeoutCalled = true;
            state.result = value * 2;
            resolve();
          }, 10)
        );
      },
    );

    const slowHandlerRecipe = recipe<{ result: number }>(
      "Slow Handler Recipe",
      ({ result }) => {
        return { result, updater: slowHandler({ result }) };
      },
    );

    const charm = run(
      slowHandlerRecipe,
      { result: 0 },
      getDoc(
        undefined,
        "idle should wait for slow async handlers",
        "test",
      ),
    );

    await idle();

    // Trigger the handler
    charm.asCell(["updater"]).send({ value: 5 });

    await idle();
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    // Now idle should wait for the handler's promise to resolve
    await timeoutPromise;
    expect(timeoutCalled).toBe(true);
    expect(charm.asCell().get()).toMatchObject({ result: 10 });
  });
});
