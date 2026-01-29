import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  type Cell,
  type JSONSchema,
  type Schema,
  SELF,
} from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";

// Import types from public API for compile-time type tests
import { type OpaqueRef } from "@commontools/api";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { isCell, isStream } from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { isPrimitiveCellLink, parseLink } from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Recipe Runner", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let derive: ReturnType<typeof createBuilder>["commontools"]["derive"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let Cell: ReturnType<typeof createBuilder>["commontools"]["Cell"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let ifElse: ReturnType<typeof createBuilder>["commontools"]["ifElse"];
  let TYPE: ReturnType<typeof createBuilder>["commontools"]["TYPE"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({
      lift,
      derive,
      recipe,
      pattern,
      Cell,
      handler,
      byRef,
      ifElse,
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

    const value = await result.pull();
    expect(value).toMatchObject({ result: 10 });
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

    const value = await result.pull();
    expect(value).toEqual({ result: 17 });
  });

  it("should handle recipes with default values", async () => {
    const recipeWithDefaults = recipe(
      {
        type: "object",
        properties: {
          a: { type: "number", default: 5 },
          b: { type: "number", default: 10 },
        },
      },
      { type: "object", properties: { sum: { type: "number" } } },
      ({ a, b }) => {
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

    const value1 = await result1.pull();
    expect(value1).toMatchObject({ sum: 15 });

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

    const value2 = await result2.pull();
    expect(value2).toMatchObject({ sum: 30 });
  });

  it("should handle recipes with map nodes", async () => {
    const multiply = lift<{ x: number; index: number; array: { x: number }[] }>(
      ({ x, index, array }) => x * (index + 1) * array.length,
    );

    const multipliedArray = recipe<{ values: { x: number }[] }>(
      "Multiply numbers",
      ({ values }) => {
        const multiplied = values.map(({ x }, index, array) => {
          return { multiplied: multiply({ x, index, array }) };
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

    const value = await result.pull();
    expect(value).toMatchObjectIgnoringSymbols({
      multiplied: [{ multiplied: 3 }, { multiplied: 12 }, { multiplied: 27 }],
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

    const value = await result.pull();
    expect(value).toMatchObjectIgnoringSymbols({ doubled: [] });
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

    await result.pull();

    result.key("stream").send({ amount: 1 });
    let value = await result.pull();
    expect(value).toMatchObject({ counter: { value: 1 } });

    result.key("stream").send({ amount: 2 });
    value = await result.pull();
    expect(value).toMatchObject({ counter: { value: 3 } });
  });

  it("should propagate handler source location to scheduler via .name", async () => {
    // Spy on addEventHandler to capture the handler passed to it
    const addEventHandlerSpy = spy(runtime.scheduler, "addEventHandler");

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
      "Handler source location test",
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "handler source location test", undefined, tx);
    const result = runtime.run(tx, incRecipe, {
      counter: { value: 0 },
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    // Verify addEventHandler was called and the handler has .name set
    expect(addEventHandlerSpy.calls.length).toBeGreaterThan(0);
    const registeredHandler = addEventHandlerSpy.calls[0].args[0];

    // The handler's .name should be set to handler:source_location (file:line:col)
    expect(registeredHandler.name).toMatch(
      /^handler:.*recipes\.test\.ts:\d+:\d+$/,
    );

    addEventHandlerSpy.restore();
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

    const incLogger = lift<
      {
        counter: { value: number };
        amount: number;
        nested: { c: number };
      },
      [number, number, number]
    >(({ counter, amount, nested }) => {
      const tuple: [number, number, number] = [counter.value, amount, nested.c];
      values.push(tuple);
      return tuple;
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

    await result.pull();

    result.key("stream").send({ amount: 1 });
    await runtime.idle();
    expect(values).toEqual([[1, 1, 0]]);

    result.key("stream").send({ amount: 2 });
    await runtime.idle();

    expect(values).toContainEqual([1, 1, 0]);

    // Next is the first logger called again when counter changes, since this
    // is now a long running piecelet:
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
    await x.pull();
    tx = runtime.edit();

    const y = runtime.getCell<number>(
      space,
      "should handle recipes returned by lifted functions 2",
      undefined,
      tx,
    );
    y.withTx(tx).set(3);
    tx.commit();
    await y.pull();
    tx = runtime.edit();

    const runCounts = {
      multiply: 0,
      multiplyGenerator: 0,
      multiplyGenerator2: 0,
    };

    const multiply = lift(
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      ({ x, y }) => {
        runCounts.multiply++;
        return x * y;
      },
    );

    const multiplyGenerator = lift(
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (args) => {
        runCounts.multiplyGenerator++;
        return multiply(args);
      },
    );

    const multiplyGenerator2 = lift(
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      ({ x, y }) => {
        runCounts.multiplyGenerator2++;
        // Now passing literals, so will hardcode values in recipe and hence
        // re-run when values change
        return multiply({ x, y });
      },
    );

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

    let value = await result.pull();
    expect(value).toMatchObject({
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

    value = await result.pull();

    expect(runCounts).toMatchObject({
      multiply: 4,
      multiplyGenerator: 2,
      multiplyGenerator2: 2,
    });

    expect(value).toMatchObject({
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

    const value = await result.pull();
    expect(value).toMatchObject({ result: 10 });
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
    await settingsCell.pull();
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

    let value = await result.pull();
    expect(value).toEqual({ result: 15 });

    // Update the cell and verify the recipe recomputes
    settingsCell.withTx(tx).send({ value: 10 });
    tx.commit();
    tx = runtime.edit();

    value = await result.pull();
    expect(value).toEqual({ result: 30 });
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

    const value = await result.pull();
    expect(value).toEqual({ result: 3 });
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

    const value = await result.pull();
    expect(value).toEqual({ result: 12 });
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

    await result.pull();

    result.key("stream").send({ amount: 1 });
    let value = await result.pull();
    expect(value).toMatchObject({ counter: 1 });

    result.key("stream").send({ amount: 2 });
    value = await result.pull();
    expect(value).toMatchObject({ counter: 3 });
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

    const pieceCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "failed handlers should be ignored",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, divRecipe, { result: 1 }, pieceCell);
    tx.commit();

    await piece.pull();

    piece.key("updater").send({ divisor: 5, dividend: 1 });
    let value = await piece.pull();
    expect(errors).toBe(0);

    expect(value).toMatchObject({ result: 5 });

    piece.key("updater").send({ divisor: 10, dividend: 0 });
    value = await piece.pull();
    expect(errors).toBe(1);
    expect(value).toMatchObject({ result: 5 });

    // Cast to any to avoid type checking
    const sourceCellValue = piece.getSourceCell()?.getRaw() as any;
    const recipeId = sourceCellValue?.[TYPE];
    expect(recipeId).toBeDefined();
    expect(lastError?.recipeId).toBe(recipeId);
    expect(isPrimitiveCellLink(sourceCellValue?.["spell"])).toBe(true);
    const spellLink = parseLink(sourceCellValue["spell"]);
    const spellId = spellLink?.id;
    expect(spellId).toBeDefined();
    expect(lastError?.spellId).toBe(spellId);
    expect(lastError?.space).toBe(space);
    expect(lastError?.pieceId).toBe(
      JSON.parse(JSON.stringify(piece.entityId))["/"],
    );

    // NOTE(ja): this test is really important after a handler
    // fails the entire system crashes!!!!
    piece.key("updater").send({ divisor: 10, dividend: 5 });
    value = await piece.pull();
    expect(value).toMatchObject({ result: 2 });
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
    await dividend.pull();
    tx = runtime.edit();

    const pieceCell = runtime.getCell<{ result: number }>(
      space,
      "failed lifted handlers should be ignored",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, divRecipe, {
      divisor: 10,
      dividend,
    }, pieceCell);
    tx.commit();
    tx = runtime.edit();

    let value = await piece.pull();

    expect(errors).toBe(0);
    expect(value).toMatchObject({ result: 10 });

    dividend.withTx(tx).send(0);
    tx.commit();
    tx = runtime.edit();

    value = await piece.pull();
    expect(errors).toBe(1);
    expect(value).toMatchObject({ result: 10 });

    const recipeId = piece.getSourceCell()?.get()?.[TYPE];
    expect(recipeId).toBeDefined();
    expect(lastError?.recipeId).toBe(recipeId);
    expect(lastError?.space).toBe(space);
    expect(lastError?.pieceId).toBe(
      JSON.parse(JSON.stringify(piece.entityId))["/"],
    );

    // Make sure it recovers:
    dividend.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();

    value = await piece.pull();
    expect((piece.getRaw() as any).result.$alias.cell).toEqual(
      piece.getSourceCell()?.entityId,
    );
    expect(value).toMatchObject({ result: 5 });
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

    // In pull-based scheduling, the lift won't run until something pulls on it.
    // Start the pull (but don't await yet) to trigger the computation.
    const pullPromise = result.pull();

    // Give time for the lift to start but not complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(liftCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    // Now await the pull to wait for completion
    const value = await pullPromise;
    expect(timeoutCalled).toBe(true);
    expect(value).toMatchObject({ result: 2 });
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

    const pieceCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "idle should wait for slow async handlers",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, slowHandlerRecipe, { result: 0 }, pieceCell);
    tx.commit();

    await piece.pull();

    // Trigger the handler
    piece.key("updater").send({ value: 5 });

    // Give a small delay to start the handler but not enough to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    // Now pull should wait for the handler's promise to resolve
    const value = await piece.pull();
    expect(timeoutCalled).toBe(true);
    expect(value).toMatchObject({ result: 10 });
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

    const pieceCell = runtime.getCell<{ result: number; updater: any }>(
      space,
      "idle should not wait for deliberately async handlers",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, slowHandlerRecipe, { result: 0 }, pieceCell);
    tx.commit();

    await piece.pull();

    // Trigger the handler
    piece.key("updater").send({ value: 5 });

    await piece.pull();
    expect(handlerCalled).toBe(true);
    expect(timeoutCalled).toBe(false);

    // Now wait for the timeout promise to resolve
    await timeoutPromise;
    expect(timeoutCalled).toBe(true);
    expect(caughtErrorTryingToSetResult).toBeDefined();
    const value = await piece.pull();
    expect(value?.result).toBe(0); // No change
  });

  it("should create and use a named cell inside a lift", async () => {
    const wrapperRecipe = recipe<{ value: number }>(
      "Wrapper with Named Cell",
      ({ value }) => {
        // Create a named cell to store the counter
        const wrapper = lift((v: number) => {
          const cell = Cell.for("wrapper").asSchema({ type: "number" }).set(v);
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

    await result.pull();

    // Initial state
    const wrapperCell = result.key("value").get();
    expect(isCell(wrapperCell)).toBe(true);
    expect(wrapperCell.get()).toBe(5);

    // Follow all the links until we get to the doc holding the value
    const ref = resolveLink(
      runtime,
      tx,
      wrapperCell.getAsNormalizedFullLink(),
    );
    expect(ref.path).toEqual([]); // = This is stored in its own document

    // And let's make sure the value is correct
    expect(tx.readValueOrThrow(ref)).toBe(5);

    input.withTx(tx).send(10);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

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

    await result.pull();

    // Add first item
    result.key("stream").send({ detail: { message: "First Item" } });
    let value = await result.pull();

    expect(value.items).toHaveLength(1);
    expect(value.items[0].title).toBe("First Item");

    // Test reuse of proxy for array items
    expect(value.items[0].items).toBe(value.items);

    // Add second item
    result.key("stream").send({ detail: { message: "Second Item" } });
    value = await result.pull();
    expect(value.items).toHaveLength(2);
    expect(value.items[1].title).toBe("Second Item");

    // All three should point to the same array
    expect(value.items[0].items).toBe(value.items);
    expect(value.items[1].items).toBe(value.items);

    // And triple check that it actually refers to the same underlying array
    expect(value.items[0].items[1].title).toBe("Second Item");

    const recurse = ({ items }: { items: { items: any[] }[] }): any =>
      items.map((item) => recurse(item));

    // Now test that we catch infinite recursion
    expect(() => recurse(value as any)).toThrow();
  });

  it("should allow sending cells to an event handler", async () => {
    const addToList = handler(
      // == { piece: Cell<any> }
      {
        type: "object",
        properties: { piece: { type: "object", asCell: true } },
        required: ["piece"],
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
      ({ piece }, { list }) => {
        list.push(piece);
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

    const pieceCell = runtime.getCell(
      space,
      "should allow sending cells to an event handler",
      listRecipe.resultSchema,
      tx,
    );

    const piece = runtime.run(tx, listRecipe, { list: [] }, pieceCell);
    tx.commit();

    await piece.pull();

    piece.key("stream").send({ piece: testCell });
    await piece.pull();

    // Add schema so we get the entry as a cell and can compare the two
    const listCell = piece.key("list").asSchema({
      type: "array",
      items: { type: "object", asCell: true },
    });
    expect(isCell(listCell.get()[0])).toBe(true);
    expect(listCell.get()[0].equals(testCell.get())).toBe(true);
  });

  it("correctly handles the ifElse values with nested derives", async () => {
    const InputSchema = {
      "type": "object",
      "properties": {
        "expandChat": { "type": "boolean" },
      },
    } as const satisfies JSONSchema;

    const StateSchema = {
      "type": "object",
      "properties": {
        "expandChat": { "type": "boolean" },
        "text": { "type": "string" },
      },
      "asCell": true,
    } as const satisfies JSONSchema;
    const expandHandler = handler(
      InputSchema,
      StateSchema,
      ({ expandChat }, state) => {
        state.key("expandChat").set(expandChat);
      },
    );

    const ifElseRecipe = recipe<{ expandChat: boolean }>(
      "ifElse Recipe",
      ({ expandChat }) => {
        const optionA = derive(expandChat, (t) => t ? "A" : "a");
        const optionB = derive(expandChat, (t) => t ? "B" : "b");

        return {
          expandChat,
          text: ifElse(
            expandChat,
            optionA,
            optionB,
          ),
          stream: expandHandler({ expandChat }),
        };
      },
    );

    const pieceCell = runtime.getCell<
      { expandChat: boolean; text: string; stream: any }
    >(
      space,
      "ifElse should work",
      ifElseRecipe.resultSchema,
      tx,
    );

    const piece = runtime.run(
      tx,
      ifElseRecipe,
      { expandChat: true },
      pieceCell,
    );

    tx.commit();

    await piece.pull();

    // Toggle
    piece.key("stream").send({ expandChat: true });
    await piece.pull();

    expect(piece.key("text").get()).toEqual("A");

    piece.key("stream").send({ expandChat: false });
    await piece.pull();

    expect(piece.key("text").get()).toEqual("b");
  });

  it("ifElse selects the correct branch based on condition", async () => {
    // This test verifies that ifElse correctly selects between branches
    // Note: Both branches may run initially as they both depend on the condition input,
    // but only the selected branch's value is used in the result.

    const ifElseRecipe = recipe<
      { condition: boolean; trueValue: string; falseValue: string }
    >(
      "ifElse selection test",
      ({ condition, trueValue, falseValue }) => {
        // Use separate inputs for each branch to make dependencies clearer
        return {
          condition,
          trueValue,
          falseValue,
          text: ifElse(condition, trueValue, falseValue),
        };
      },
    );

    const pieceCell = runtime.getCell<
      {
        condition: boolean;
        trueValue: string;
        falseValue: string;
        text: string;
      }
    >(
      space,
      "ifElse selection test",
      ifElseRecipe.resultSchema,
      tx,
    );

    // Start with condition = true
    const piece = runtime.run(
      tx,
      ifElseRecipe,
      { condition: true, trueValue: "A", falseValue: "B" },
      pieceCell,
    );

    tx.commit();
    await piece.pull();

    // With condition=true, ifElse should select trueValue
    expect(piece.key("text").get()).toEqual("A");

    // Now switch condition to false
    tx = runtime.edit();
    piece.withTx(tx).key("condition").set(false);
    tx.commit();
    await piece.pull();

    // With condition=false, ifElse should select falseValue
    expect(piece.key("text").get()).toEqual("B");

    // Change the falseValue and verify it updates
    tx = runtime.edit();
    piece.withTx(tx).key("falseValue").set("C");
    tx.commit();
    await piece.pull();

    expect(piece.key("text").get()).toEqual("C");
  });

  it("should allow Cell<Array>.push of newly created pieces", async () => {
    const InnerSchema = {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    } as const satisfies JSONSchema;

    const OuterSchema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: InnerSchema,
          default: [],
          asCell: true,
        },
      },
      required: ["list"],
    } as const satisfies JSONSchema;

    const HandlerState = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: InnerSchema,
          default: [],
          asCell: true,
        },
      },
      required: ["list"],
    } as const satisfies JSONSchema;

    const OutputWithHandler = {
      type: "object",
      properties: {
        list: { type: "array", items: InnerSchema, asCell: true },
        add: { ...InnerSchema, asStream: true },
      },
      required: ["add", "list"],
    } as const satisfies JSONSchema;

    const pieceCell = runtime.getCell<Schema<typeof OutputWithHandler>>(
      space,
      "should allow Cell<Array>.push of newly created pieces",
      OutputWithHandler,
      tx,
    );

    const innerPattern = pattern(
      ({ text }) => {
        return { text };
      },
      InnerSchema,
      InnerSchema,
    );

    const add = handler(
      InnerSchema,
      HandlerState,
      ({ text }, { list }) => {
        const inner = innerPattern({ text });
        list.push(inner);
      },
    );

    const outerPattern = pattern(
      ({ list }) => {
        return { list, add: add({ list }) };
      },
      OuterSchema,
      OutputWithHandler,
    );

    runtime.run(tx, outerPattern, {}, pieceCell);
    tx.commit();

    await pieceCell.pull();

    tx = runtime.edit();

    const result = pieceCell.withTx(tx).get();
    expect(isCell(result.list)).toBe(true);
    expect(result.list.get()).toEqual([]);
    expect(isStream(result.add)).toBe(true);

    result.add.withTx(tx).send({ text: "hello" });
    tx.commit();

    await pieceCell.pull();

    tx = runtime.edit();
    const result2 = pieceCell.withTx(tx).get();
    expect(result2.list.get()).toEqual([{ text: "hello" }]);
  });

  it("should wait for lift before handler that reads lift output from event", async () => {
    // This test verifies that when handler A creates a lift and sends its output
    // as an event to handler B, the scheduler waits for the lift to complete
    // before running handler B.
    //
    // Flow:
    // 1. Send { value: 5 } to streamA
    // 2. Handler A creates a lift (double(value)) and sends its output to streamB
    // 3. Handler B receives the lift output cell, reads its value, and logs it
    // 4. The lift must run before handler B can read the correct value (10)
    //
    // This test should FAIL if populateDependencies doesn't receive the event,
    // because then the scheduler won't know handler B depends on the lift output.

    const log: number[] = [];

    // Lift that doubles a number
    const double = lift((x: number) => x * 2);

    // Handler B receives an event (a cell reference) and logs its value
    const handlerB = handler(
      // Event: a cell reference (link to the doubled output)
      { type: "number", asCell: true },
      // No state needed
      {},
      (eventCell, _state) => {
        // Read the cell value and log it
        const value = eventCell.get();
        log.push(value);
      },
    );

    // Handler A receives a value, creates a lift, and sends its output to streamB
    const handlerA = handler(
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      {
        type: "object",
        properties: {
          streamB: { asStream: true },
        },
        required: ["streamB"],
      },
      ({ value }, { streamB }) => {
        // Create the lift dynamically and send its output to streamB
        const doubled = double(value);
        streamB.send(doubled);
        return doubled;
      },
    );

    const testRecipe = recipe(
      "Handler dependency pulling test",
      () => {
        // Create handler B's stream (receives cell references, logs values)
        const streamB = handlerB({});

        // Create handler A's stream (creates lift and dispatches to streamB)
        const streamA = handlerA({ streamB });

        return { streamA };
      },
    );

    const resultCell = runtime.getCell<{ streamA: any }>(
      space,
      "should wait for lift before handler that reads lift output from event",
      undefined,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    // Verify initial state
    expect(log).toEqual([]);

    // Send an event to handler A with value 5
    result.key("streamA").send({ value: 5 });
    await result.pull();

    // Handler B should have logged 10 (5 * 2) - the lift must have run first
    // If the lift didn't run before handler B, we'd get undefined or wrong value
    expect(log).toEqual([10]);

    // Send another event to verify consistent behavior
    result.key("streamA").send({ value: 7 });
    await result.pull();

    // Handler B should have logged 14 (7 * 2)
    expect(log).toEqual([10, 14]);
  });

  it("should support non-reactive reads with sample()", async () => {
    let liftRunCount = 0;

    // A lift that takes two parameters:
    // - first: a regular number (reactive)
    // - second: a Cell that we'll read with sample() (non-reactive)
    const computeWithSample = lift(
      // Input schema: first is reactive, second is asCell
      {
        type: "object",
        properties: {
          first: { type: "number" },
          second: { type: "number", asCell: true },
        },
        required: ["first", "second"],
      } as const satisfies JSONSchema,
      // Output schema
      { type: "number" },
      // The lift function
      ({ first, second }) => {
        liftRunCount++;
        // Use sample() to read the second cell non-reactively
        const secondValue = second.sample();
        return first + secondValue;
      },
    );

    const sampleRecipe = recipe<{ first: number; second: number }>(
      "Sample Recipe",
      ({ first, second }) => {
        return { result: computeWithSample({ first, second }) };
      },
    );

    // Create input cells
    const firstCell = runtime.getCell<number>(
      space,
      "sample test first cell",
      undefined,
      tx,
    );
    firstCell.set(10);

    const secondCell = runtime.getCell<number>(
      space,
      "sample test second cell",
      undefined,
      tx,
    );
    secondCell.set(5);

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should support non-reactive reads with sample()",
      {
        type: "object",
        properties: { result: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sampleRecipe, {
      first: firstCell,
      second: secondCell,
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    let value = await result.pull();

    // Verify initial result: 10 + 5 = 15
    expect(value).toMatchObject({ result: 15 });
    expect(liftRunCount).toBe(1);

    // Update the second cell (read with sample(), so non-reactive)
    secondCell.withTx(tx).send(20);
    tx.commit();
    tx = runtime.edit();

    value = await result.pull();

    // The lift should NOT have re-run because sample() is non-reactive
    expect(liftRunCount).toBe(1);
    // Result should still be 15 (not updated)
    expect(value).toMatchObject({ result: 15 });

    // Now update the first cell (read reactively via the normal get())
    firstCell.withTx(tx).send(100);
    tx.commit();
    tx = runtime.edit();

    value = await result.pull();

    // The lift should have re-run now
    expect(liftRunCount).toBe(2);
    // Result should reflect both new values: 100 + 20 = 120
    // (the second cell's new value is picked up because the lift re-ran)
    expect(value).toMatchObject({ result: 120 });
  });

  it("should not run lifts until something pulls on them", async () => {
    // This test verifies true pull-based scheduling:
    // - Create two independent recipes with lifts
    // - Instantiate both
    // - Pull only on the first one's result
    // - Only the lift in the first recipe should run

    let lift1Runs = 0;
    let lift2Runs = 0;

    const recipe1 = recipe<{ value: number }>(
      "Recipe 1 with lift",
      ({ value }) => {
        const doubled = lift(
          { type: "number" } as const satisfies JSONSchema,
          { type: "number" } as const satisfies JSONSchema,
          (x: number) => {
            lift1Runs++;
            return x * 2;
          },
        )(value);
        return { result: doubled };
      },
    );

    const recipe2 = recipe<{ value: number }>(
      "Recipe 2 with lift",
      ({ value }) => {
        const tripled = lift(
          { type: "number" } as const satisfies JSONSchema,
          { type: "number" } as const satisfies JSONSchema,
          (x: number) => {
            lift2Runs++;
            return x * 3;
          },
        )(value);
        return { result: tripled };
      },
    );

    // Instantiate both recipes
    const resultCell1 = runtime.getCell<{ result: number }>(
      space,
      "lift-pull-test-recipe1",
      undefined,
      tx,
    );
    const resultCell2 = runtime.getCell<{ result: number }>(
      space,
      "lift-pull-test-recipe2",
      undefined,
      tx,
    );

    const result1 = runtime.run(tx, recipe1, { value: 5 }, resultCell1);
    const result2 = runtime.run(tx, recipe2, { value: 5 }, resultCell2);
    tx.commit();
    tx = runtime.edit();

    // Before any pull, no lifts should have run
    expect(lift1Runs).toBe(0);
    expect(lift2Runs).toBe(0);

    // Pull only on recipe 1's result
    const value1 = await result1.pull();
    expect(value1).toMatchObject({ result: 10 });

    // Both lifts run because the scheduler flushes everything
    expect(lift1Runs).toBe(1);
    expect(lift2Runs).toBe(1);

    // Now pull on recipe 2's result
    const value2 = await result2.pull();
    expect(value2).toMatchObject({ result: 15 });

    // Still 1
    expect(lift1Runs).toBe(1);
    expect(lift2Runs).toBe(1);
  });

  it("should provide SELF reference in pattern for self-referential types", async () => {
    // Define schemas using JSON schema notation
    const InputSchema = {
      type: "object",
      properties: {
        label: { type: "string", default: "Node" },
      },
    } as const satisfies JSONSchema;

    const OutputSchema = {
      type: "object",
      properties: {
        label: { type: "string" },
        children: {
          type: "array",
          items: { type: "object" }, // Self-referential
          default: [],
        },
        hasSelf: { type: "boolean" },
      },
    } as const satisfies JSONSchema;

    // Create a pattern that uses SELF
    const treeNodePattern = pattern(
      (input: any) => {
        const label = input.label;
        const self = input[SELF];

        // children typed as array of self
        const children = [] as (typeof self)[];

        return {
          label,
          children,
          hasSelf: self !== undefined,
        };
      },
      InputSchema,
      OutputSchema,
    );

    const resultCell = runtime.getCell<{
      label: string;
      children: any[];
      hasSelf: boolean;
    }>(
      space,
      "should provide SELF reference in pattern",
      OutputSchema,
      tx,
    );

    const result = runtime.run(
      tx,
      treeNodePattern,
      { label: "Root" },
      resultCell,
    );
    tx.commit();

    const value = await result.pull();

    // Verify SELF was available
    expect(value.hasSelf).toBe(true);
    expect(value.label).toBe("Root");
    expect(value.children).toEqual([]);
  });

  it("should serialize SELF reference to resultRef path", () => {
    const InputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    } as const satisfies JSONSchema;

    const OutputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        self: { type: "object" },
      },
    } as const satisfies JSONSchema;

    // Pattern that exposes self in output
    const selfRefPattern = pattern(
      (input: any) => {
        const self = input[SELF];
        return {
          name: input.name,
          self, // Expose the self reference
        };
      },
      InputSchema,
      OutputSchema,
    );

    // Check the serialized recipe structure
    const serialized = JSON.parse(JSON.stringify(selfRefPattern));

    // The self field in the result should be an alias to resultRef
    expect(serialized.result.self.$alias.path).toEqual(["resultRef"]);
  });

  it("should allow SELF in recipe function as well as pattern", async () => {
    const InputSchema = {
      type: "object",
      properties: {
        value: { type: "number", default: 0 },
      },
    } as const satisfies JSONSchema;

    const OutputSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        selfAvailable: { type: "boolean" },
      },
    } as const satisfies JSONSchema;

    // Recipe (not pattern) that uses SELF
    const selfRecipe = recipe(
      InputSchema,
      OutputSchema,
      (input: any) => {
        const self = input[SELF];
        return {
          value: input.value,
          selfAvailable: self !== undefined,
        };
      },
    );

    const resultCell = runtime.getCell<{
      value: number;
      selfAvailable: boolean;
    }>(
      space,
      "should allow SELF in recipe function",
      OutputSchema,
      tx,
    );

    const result = runtime.run(tx, selfRecipe, { value: 42 }, resultCell);
    tx.commit();

    const value = await result.pull();

    expect(value.selfAvailable).toBe(true);
    expect(value.value).toBe(42);
  });

  it("should correctly infer SELF type (TypeScript types, compile-time check)", () => {
    // This test verifies SELF type inference using the PUBLIC API types from @commontools/api
    // The @ts-expect-error directives verify that SELF is NOT typed as `any`
    // If SELF were `any`, the "wrong type" assignments would succeed,
    // making @ts-expect-error unused - which is itself a compile error

    interface TreeNode {
      name: string;
      children: TreeNode[];
    }

    const treePattern = pattern<{ name: string }, TreeNode>(
      ({ name, [SELF]: self }) => {
        // Positive type tests: these assignments SHOULD work
        const _correctType: OpaqueRef<TreeNode> = self;
        const _correctChildren: OpaqueRef<TreeNode[]> = self.children;
        const _correctName: OpaqueRef<string> = self.name;

        // Negative type tests: these should NOT work (verified by @ts-expect-error)
        // If self were ApiOpaqueRef<any>, these would succeed, making @ts-expect-error unused
        // @ts-expect-error - self should not be assignable to ApiOpaqueRef<{ wrong: true }>
        const _wrongType: OpaqueRef<{ wrong: true }> = self;
        // @ts-expect-error - children should not be assignable to ApiOpaqueRef<string[]>
        const _wrongChildren: OpaqueRef<string[]> = self.children;

        // Use self in the return type
        const children: (typeof self)[] = [];

        return { name, children };
      },
    );

    // Verify it's a valid pattern at runtime
    expect(treePattern).toBeDefined();
    expect(typeof treePattern).toBe("function");
  });

  it("should run dynamically instantiated recipes before reading their outputs", async () => {
    // This test reproduces a bug where:
    // 1. A lift dynamically instantiates recipes and pushes them to an array
    // 2. Another lift reads computed values from those array entries
    // 3. The dynamically instantiated recipes haven't executed yet, so their
    //    computed outputs are undefined
    //
    // The bug manifests with push-based scheduling (sink + idle) but not with
    // pull-based scheduling (pull()) because pull correctly traverses the
    // dependency chain.

    // Inner recipe that computes itemCount from a values array
    const itemCountRecipe = recipe(
      // Input schema
      {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: { type: "number" },
            default: [],
          },
        },
      } as const satisfies JSONSchema,
      // Output schema
      {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          itemCount: { type: "number" },
        },
      } as const satisfies JSONSchema,
      ({ values }) => {
        // Compute item count from values
        const itemCount = lift(
          {
            type: "array",
            items: { type: "number" },
          } as const satisfies JSONSchema,
          { type: "number" } as const satisfies JSONSchema,
          (arr: number[]) => (Array.isArray(arr) ? arr.length : 0),
        )(values);

        return { values, itemCount };
      },
    );

    // Lift that dynamically instantiates itemCountRecipe for each group
    const instantiateGroups = lift(
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
              },
            },
            asCell: true,
          },
        },
        required: ["groups"],
      } as const satisfies JSONSchema,
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "number" } },
            itemCount: { type: "number" },
          },
        },
      } as const satisfies JSONSchema,
      ({ groups }) => {
        const raw = groups.get();
        const list = Array.isArray(raw) ? raw : [];
        const children = [];
        for (let index = 0; index < list.length; index++) {
          const groupCell = groups.key(index)!;
          const valuesCell = groupCell.key("values");
          const child = itemCountRecipe({
            values: valuesCell,
          });
          children.push(child);
        }
        return children;
      },
    );

    // Lift that sums itemCount from all groups
    const computeTotalItems = lift(
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            itemCount: { type: "number" },
          },
        },
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (entries: Array<{ itemCount?: number }>) => {
        if (!Array.isArray(entries)) {
          return 0;
        }
        return entries.reduce((sum, entry) => {
          const count = entry?.itemCount;
          return typeof count === "number" ? sum + count : sum;
        }, 0);
      },
    );

    // Outer recipe that uses instantiateGroups and computeTotalItems
    const outerRecipe = recipe(
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
              },
            },
            default: [],
          },
        },
      } as const satisfies JSONSchema,
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
                itemCount: { type: "number" },
              },
            },
          },
          totalItems: { type: "number" },
        },
      } as const satisfies JSONSchema,
      ({ groups: groupSeeds }) => {
        const groups = instantiateGroups({ groups: groupSeeds });
        const totalItems = computeTotalItems(groups);
        return { groups, totalItems };
      },
    );

    const resultCell = runtime.getCell<{
      groups: Array<{ values: number[]; itemCount: number }>;
      totalItems: number;
    }>(
      space,
      "should run dynamically instantiated recipes before reading their outputs",
      undefined,
      tx,
    );

    const result = runtime.run(tx, outerRecipe, {
      groups: [
        { values: [1, 2, 3] },
        { values: [4, 5] },
      ],
    }, resultCell);
    tx.commit();

    const value = await result.pull();

    // The bug: totalItems would be 0 because the dynamically instantiated
    // recipes haven't run yet when computeTotalItems executes
    expect(value.groups).toHaveLength(2);
    expect(value.groups![0].itemCount).toBe(3);
    expect(value.groups![1].itemCount).toBe(2);
    expect(value.totalItems).toBe(5); // This fails if nested recipes aren't run first
  });
});
