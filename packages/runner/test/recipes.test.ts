import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Cell, type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { isCell } from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { isAnyCellLink, parseLink } from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Recipe Runner", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let createCell: ReturnType<typeof createBuilder>["commontools"]["createCell"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let TYPE: ReturnType<typeof createBuilder>["commontools"]["TYPE"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder(runtime);
    ({
      lift,
      recipe,
      createCell,
      handler,
      byRef,
      TYPE,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should run a simple recipe", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { result: doubled };
      },
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should run a simple recipe",
      undefined,
      tx,
    );
    const result = runtime.run(tx, simpleRecipe, {
      value: 5,
    }, resultCell);
    tx.commit();

    await runtime.idle();

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

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle nested recipes",
      undefined,
      tx,
    );
    const result = runtime.run(tx, outerRecipe, {
      value: 4,
    }, resultCell);
    tx.commit();

    await runtime.idle();

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

    const resultCell1 = runtime.getCell<{ sum: number }>(
      space,
      "should handle recipes with defaults",
      undefined,
      tx,
    );
    const result1 = runtime.run(
      tx,
      recipeWithDefaults,
      {},
      resultCell1,
    );
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(result1.getAsQueryResult()).toMatchObject({ sum: 15 });

    const resultCell2 = runtime.getCell<{ sum: number }>(
      space,
      "should handle recipes with defaults (2)",
      undefined,
      tx,
    );
    const result2 = runtime.run(tx, recipeWithDefaults, {
      a: 20,
    }, resultCell2);
    tx.commit();

    await runtime.idle();

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

    const resultCell = runtime.getCell(
      space,
      "should handle recipes with map nodes",
      {
        type: "object",
        properties: {
          multiplied: {
            type: "array",
            items: {
              type: "object",
              properties: { multiplied: { type: "number" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, multipliedArray, {
      values: [{ x: 1 }, { x: 2 }, { x: 3 }],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
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

    const resultCell = runtime.getCell(
      space,
      "should handle recipes with map nodes with closures",
      {
        type: "object",
        properties: {
          doubled: { type: "array", items: { type: "number" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: [1, 2, 3],
      factor: 3,
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
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

    const resultCell = runtime.getCell(
      space,
      "should handle map nodes with undefined input",
      {
        type: "object",
        properties: { doubled: { type: "array", items: { type: "number" } } },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: undefined,
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ doubled: [] });
  });

  it("should execute handlers", async () => {
    const incHandler = handler<
      { amount: number },
      { counter: { value: number } }
    >(
      ({ amount }, { counter }) => {
        counter.value += amount;
      },
      { proxy: true },
    );

    const incRecipe = recipe<{ counter: { value: number } }>(
      "Increment counter",
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "should execute handlers", undefined, tx);
    const result = runtime.run(tx, incRecipe, {
      counter: { value: 0 },
    }, resultCell);
    tx.commit();

    await runtime.idle();

    result.key("stream").send({ amount: 1 });
    await runtime.idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 1 } });

    result.key("stream").send({ amount: 2 });
    await runtime.idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: { value: 3 } });
  });

  it("should execute recipes returned by handlers", async () => {
    const counter = runtime.getCell<{ value: number }>(
      space,
      "should execute recipes returned by handlers 1",
      undefined,
      tx,
    );
    counter.set({ value: 0 });
    const nested = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should execute recipes returned by handlers 2",
      undefined,
      tx,
    );
    nested.set({ a: { b: { c: 0 } } });

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
    >(
      (event, { counter, nested }) => {
        counter.value += event.amount;
        return incLogger({ counter, amount: event.amount, nested: nested.a.b });
      },
      { proxy: true },
    );

    const incRecipe = recipe<{
      counter: { value: number };
      nested: { a: { b: { c: number } } };
    }>("event handler that returns a graph", ({ counter, nested }) => {
      const stream = incHandler({ counter, nested });
      return { stream };
    });

    const resultCell = runtime.getCell<{ stream: any }>(
      space,
      "should execute recipes returned by handlers",
      undefined,
      tx,
    );
    const result = runtime.run(tx, incRecipe, {
      counter,
      nested,
    }, resultCell);
    tx.commit();

    await runtime.idle();

    result.key("stream").send({ amount: 1 });
    await runtime.idle();
    expect(values).toEqual([[1, 1, 0]]);

    result.key("stream").send({ amount: 2 });
    await runtime.idle();

    expect(values).toContainEqual([1, 1, 0]);

    // Next is the first logger called again when counter changes, since this
    // is now a long running charmlet:
    expect(values).toContainEqual([3, 1, 0]);

    expect(values).toContainEqual([3, 2, 0]);
  });

  it("should handle recipes returned by lifted functions", async () => {
    const x = runtime.getCell<number>(
      space,
      "should handle recipes returned by lifted functions 1",
    );
    x.withTx(tx).set(2);
    tx.commit();
    tx = runtime.edit();

    const y = runtime.getCell<number>(
      space,
      "should handle recipes returned by lifted functions 2",
      undefined,
      tx,
    );
    y.withTx(tx).set(3);
    tx.commit();
    tx = runtime.edit();

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

    const resultCell = runtime.getCell<{ result1: number; result2: number }>(
      space,
      "should handle recipes returned by lifted functions",
      undefined,
      tx,
    );
    const result = runtime.run(tx, multiplyRecipe, {
      x,
      y,
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    expect(runCounts).toMatchObject({
      multiply: 0,
      multiplyGenerator: 0,
      multiplyGenerator2: 0,
    });

    await runtime.idle();

    expect(result.getAsQueryResult()).toMatchObject({
      result1: 6,
      result2: 6,
    });

    // We mark the process cell dirty, run, then mark the process cell dirty again.
    expect(runCounts).toMatchObject({
      multiply: 2,
      multiplyGenerator: 1,
      multiplyGenerator2: 1,
    });

    x.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

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
    runtime.moduleRegistry.addModuleByRef(
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

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should support referenced modules",
      undefined,
      tx,
    );
    const result = runtime.run(tx, simpleRecipe, {
      value: 5,
    }, resultCell);
    tx.commit();

    await runtime.idle();

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

    const settingsCell = runtime.getCell<{ value: number }>(
      space,
      "should handle schema with cell references 1",
      undefined,
      tx,
    );
    settingsCell.withTx(tx).set({ value: 5 });
    tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle schema with cell references",
      undefined,
      tx,
    );
    const result = runtime.run(tx, multiplyRecipe, {
      settings: settingsCell,
      multiplier: 3,
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.getAsQueryResult()).toEqual({ result: 15 });

    // Update the cell and verify the recipe recomputes
    settingsCell.withTx(tx).send({ value: 10 });
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

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

    const item1 = runtime.getCell<{ value: number }>(
      space,
      "should handle nested cell references in schema 1",
      undefined,
      tx,
    );
    item1.set({ value: 1 });
    const item2 = runtime.getCell<{ value: number }>(
      space,
      "should handle nested cell references in schema 2",
      undefined,
      tx,
    );
    item2.set({ value: 2 });
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle nested cell references in schema",
      undefined,
      tx,
    );
    const result = runtime.run(tx, sumRecipe, {
      data: { items: [item1, item2] },
    }, resultCell);
    tx.commit();

    await runtime.idle();

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

    const dynamicRecipe = recipe<
      { context: Record<PropertyKey, number> }
    >(
      "Dynamic Context",
      ({ context }) => {
        const result = lift(
          schema,
          { type: "number" },
          ({ context }) =>
            Object.values(context ?? {}).reduce(
              (sum: number, val) => sum + val.get(),
              0,
            ),
        )({ context });
        return { result };
      },
    );

    const value1 = runtime.getCell<number>(
      space,
      "should handle dynamic cell references with schema 1",
      undefined,
      tx,
    );
    value1.set(5);
    const value2 = runtime.getCell<number>(
      space,
      "should handle dynamic cell references with schema 2",
      undefined,
      tx,
    );
    value2.set(7);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle dynamic cell references with schema",
      undefined,
      tx,
    );
    const result = runtime.run(tx, dynamicRecipe, {
      context: {
        first: value1,
        second: value2,
      },
    }, resultCell);
    tx.commit();

    await runtime.idle();

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

    const resultCell = runtime.getCell<{ counter: number; stream: any }>(
      space,
      "should execute handlers with schemas",
      undefined,
      tx,
    );
    const result = runtime.run(tx, incRecipe, {
      counter: 0,
    }, resultCell);
    tx.commit();

    await runtime.idle();

    result.key("stream").send({ amount: 1 });
    await runtime.idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: 1 });

    result.key("stream").send({ amount: 2 });
    await runtime.idle();
    expect(result.getAsQueryResult()).toMatchObject({ counter: 3 });
  });

  it("failed handlers should be ignored", async () => {
    let errors = 0;
    let lastError: ErrorWithContext | undefined;

    runtime.scheduler.onError((error: ErrorWithContext) => {
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
      { proxy: true },
    );

    const divRecipe = recipe<{ result: number }>(
      "Divide numbers",
      ({ result }) => {
        return { updater: divHandler({ result }), result };
      },
    );

    const charmCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "failed handlers should be ignored",
      undefined,
      tx,
    );
    const charm = runtime.run(tx, divRecipe, { result: 1 }, charmCell);
    tx.commit();

    await runtime.idle();

    charm.key("updater").send({ divisor: 5, dividend: 1 });
    await runtime.idle();
    expect(errors).toBe(0);

    expect(charm.getAsQueryResult()).toMatchObject({ result: 5 });

    charm.key("updater").send({ divisor: 10, dividend: 0 });
    await runtime.idle();
    expect(errors).toBe(1);
    expect(charm.getAsQueryResult()).toMatchObject({ result: 5 });

    // Cast to any to avoid type checking
    const sourceCellValue = charm.getSourceCell()?.getRaw() as any;
    const recipeId = sourceCellValue?.[TYPE];
    expect(recipeId).toBeDefined();
    expect(lastError?.recipeId).toBe(recipeId);
    expect(isAnyCellLink(sourceCellValue?.["spell"])).toBe(true);
    const spellLink = parseLink(sourceCellValue["spell"]);
    const spellId = spellLink?.id;
    expect(spellId).toBeDefined();
    expect(lastError?.spellId).toBe(spellId);
    expect(lastError?.space).toBe(space);
    expect(lastError?.charmId).toBe(
      JSON.parse(JSON.stringify(charm.entityId))["/"],
    );

    // NOTE(ja): this test is really important after a handler
    // fails the entire system crashes!!!!
    charm.key("updater").send({ divisor: 10, dividend: 5 });
    await runtime.idle();
    expect(charm.getAsQueryResult()).toMatchObject({ result: 2 });
  });

  it("failed lifted functions should be ignored", async () => {
    let errors = 0;
    let lastError: ErrorWithContext | undefined;

    runtime.scheduler.onError((error: ErrorWithContext) => {
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

    const dividend = runtime.getCell<number>(
      space,
      "failed lifted functions should be ignored 1",
      undefined,
      tx,
    );
    dividend.withTx(tx).set(1);
    tx.commit();
    tx = runtime.edit();

    const charmCell = runtime.getCell<{ result: number }>(
      space,
      "failed lifted handlers should be ignored",
      undefined,
      tx,
    );
    const charm = runtime.run(tx, divRecipe, {
      divisor: 10,
      dividend,
    }, charmCell);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(errors).toBe(0);
    expect(charm.get()).toMatchObject({ result: 10 });

    dividend.withTx(tx).send(0);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();
    expect(errors).toBe(1);
    expect(charm.getAsQueryResult()).toMatchObject({ result: 10 });

    const recipeId = charm.getSourceCell()?.get()?.[TYPE];
    expect(recipeId).toBeDefined();
    expect(lastError?.recipeId).toBe(recipeId);
    expect(lastError?.space).toBe(space);
    expect(lastError?.charmId).toBe(
      JSON.parse(JSON.stringify(charm.entityId))["/"],
    );

    // Make sure it recovers:
    dividend.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();
    expect((charm.getRaw() as any).result.$alias.cell).toEqual(
      charm.getSourceCell()?.entityId,
    );
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

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "idle should wait for slow async lifted functions",
      undefined,
      tx,
    );
    const result = runtime.run(tx, slowRecipe, { x: 1 }, resultCell);
    tx.commit();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(liftCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    await runtime.idle();
    expect(timeoutCalled).toBe(true);
    expect(result.get()).toMatchObject({ result: 2 });
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
      { proxy: true },
    );

    const slowHandlerRecipe = recipe<{ result: number }>(
      "Slow Handler Recipe",
      ({ result }) => {
        return { result, updater: slowHandler({ result }) };
      },
    );

    const charmCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "idle should wait for slow async handlers",
      undefined,
      tx,
    );
    const charm = runtime.run(tx, slowHandlerRecipe, { result: 0 }, charmCell);
    tx.commit();

    await runtime.idle();

    // Trigger the handler
    charm.key("updater").send({ value: 5 });

    // Give a small delay to start the handler but not enough to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    // Now idle should wait for the handler's promise to resolve
    await runtime.idle();
    expect(timeoutCalled).toBe(true);
    expect(charm.get()).toMatchObject({ result: 10 });
  });

  it("idle should not wait for deliberately async handlers and writes should fail", async () => {
    let handlerCalled = false;
    let timeoutCalled = false;
    let timeoutPromise: Promise<void> | undefined;
    let caughtErrorTryingToSetResult: Error | undefined;

    const slowHandler = handler<{ value: number }, { result: number }>(
      ({ value }, state) => {
        handlerCalled = true;
        // Capturing the promise, but _not_ returning it.
        timeoutPromise = new Promise<void>((resolve) =>
          setTimeout(() => {
            timeoutCalled = true;
            try {
              state.result = value * 2;
            } catch (error) {
              caughtErrorTryingToSetResult = error as Error;
            }
            resolve();
          }, 10)
        );
      },
      { proxy: true },
    );

    const slowHandlerRecipe = recipe<{ result: number }>(
      "Slow Handler Recipe",
      ({ result }) => {
        return { result, updater: slowHandler({ result }) };
      },
    );

    const charmCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "idle should not wait for deliberately async handlers",
      undefined,
      tx,
    );
    const charm = runtime.run(tx, slowHandlerRecipe, { result: 0 }, charmCell);
    tx.commit();

    await runtime.idle();

    // Trigger the handler
    charm.key("updater").send({ value: 5 });

    await runtime.idle();
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    // Now idle should wait for the handler's promise to resolve
    await timeoutPromise;
    expect(timeoutCalled).toBe(true);
    expect(caughtErrorTryingToSetResult).toBeDefined();
    expect(charm.get()?.result).toBe(0); // No change
  });

  it("should create and use a named cell inside a lift", async () => {
    const wrapperRecipe = recipe<{ value: number }>(
      "Wrapper with Named Cell",
      ({ value }) => {
        // Create a named cell to store the counter
        const wrapper = lift((v: number) => {
          const cell = createCell({ type: "number" }, "wrapper", v);
          return { value: cell };
        })(value);

        return wrapper;
      },
    );

    const input = runtime.getCell<number>(
      space,
      "should create and use a named cell inside a lift input",
    );
    input.withTx(tx).set(5);
    tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<{ value: Cell<number> }>(
      space,
      "should create and use a named cell inside a lift",
      {
        type: "object",
        properties: { value: { type: "number", asCell: true } },
        required: ["value"],
      },
    );

    const result = runtime.run(tx, wrapperRecipe, { value: input }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    // Initial state
    const wrapperCell = result.key("value").get();
    expect(isCell(wrapperCell)).toBe(true);
    expect(wrapperCell.get()).toBe(5);

    // Follow all the links until we get to the doc holding the value
    const ref = resolveLink(
      tx,
      wrapperCell.getAsNormalizedFullLink(),
    );
    expect(ref.path).toEqual([]); // = This is stored in its own document

    // And let's make sure the value is correct
    expect(tx.readValueOrThrow(ref)).toBe(5);

    input.withTx(tx).send(10);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    // That same value was updated, which shows that the id was stable
    expect(tx.readValueOrThrow(ref)).toBe(10);
  });

  it("should handle pushing objects that reference their containing array", async () => {
    const addItemHandler = handler(
      // Event schema
      {
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
        required: ["detail"],
      },
      // State schema with self-referential items via $defs
      {
        $defs: {
          Items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                items: { $ref: "#/$defs/Items" },
              },
              required: ["title", "items"],
            },
            default: [],
          },
        },
        type: "object",
        properties: {
          items: { $ref: "#/$defs/Items", asCell: true },
        },
        required: ["items"],
      },
      (event, { items }) => {
        const title = event.detail?.message?.trim();
        if (title) {
          items.push({ title, items });
        }
      },
    );

    const itemsRecipe = recipe<
      { items: Array<{ title: string; items: any[] }> }
    >(
      "Items with self-reference",
      ({ items }) => {
        return { items, stream: addItemHandler({ items }) };
      },
    );

    const resultCell = runtime.getCell<{ items: any[]; stream: any }>(
      space,
      "should handle pushing objects that reference their containing array",
      undefined,
      tx,
    );
    const result = runtime.run(tx, itemsRecipe, { items: [] }, resultCell);
    tx.commit();

    await runtime.idle();

    // Add first item
    result.key("stream").send({ detail: { message: "First Item" } });
    await runtime.idle();

    const firstState = result.getAsQueryResult();
    expect(firstState.items).toHaveLength(1);
    expect(firstState.items[0].title).toBe("First Item");

    // Test reuse of proxy for array items
    expect(firstState.items[0].items).toBe(firstState.items);

    // Add second item
    result.key("stream").send({ detail: { message: "Second Item" } });
    await runtime.idle();

    const secondState = result.getAsQueryResult();
    expect(secondState.items).toHaveLength(2);
    expect(secondState.items[1].title).toBe("Second Item");

    // All three should point to the same array
    expect(secondState.items[0].items).toBe(secondState.items);
    expect(secondState.items[1].items).toBe(secondState.items);

    // And triple check that it actually refers to the same underlying array
    expect(firstState.items[0].items[1].title).toBe("Second Item");

    const recurse = ({ items }: { items: { items: any[] }[] }): any =>
      items.map((item) => recurse(item));

    // Now test that we catch infinite recursion
    expect(() => recurse(firstState)).toThrow();
  });

  it("should allow sending cells to an event handler", async () => {
    const addToList = handler(
      // == { charm: Cell<any> }
      {
        type: "object",
        properties: { charm: { type: "object", asCell: true } },
        required: ["charm"],
      },
      // == { list: Cell<any>[] }
      {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: { type: "object", asCell: true },
            asCell: true,
          },
        },
        required: ["list"],
      },
      ({ charm }, { list }) => {
        list.push(charm);
      },
    );

    const listRecipe = recipe<{ list: any[] }>(
      "List Recipe",
      ({ list }) => {
        return { list, stream: addToList({ list }) };
      },
    );

    const testCell = runtime.getCell<{ value: number }>(
      space,
      "should allow sending cells to an event handler",
      undefined,
      tx,
    );

    const charmCell = runtime.getCell(
      space,
      "should allow sending cells to an event handler",
      listRecipe.resultSchema,
      tx,
    );

    const charm = runtime.run(tx, listRecipe, { list: [] }, charmCell);
    tx.commit();

    await runtime.idle();

    charm.key("stream").send({ charm: testCell });
    await runtime.idle();

    // Add schema so we get the entry as a cell and can compare the two
    const listCell = charm.key("list").asSchema({
      type: "array",
      items: { type: "object", asCell: true },
    });
    expect(isCell(listCell.get()[0])).toBe(true);
    expect(listCell.get()[0].equals(testCell.get())).toBe(true);
  });
});
