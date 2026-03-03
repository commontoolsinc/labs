// Event handlers: defining and invoking handlers, handler metadata,
// handler-produced side effects, schema-annotated handlers, and handler errors.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Cell } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { isPrimitiveCellLink, parseLink } from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Handlers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let TYPE: ReturnType<typeof createBuilder>["commontools"]["TYPE"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({
      lift,
      pattern,
      handler,
      TYPE,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
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

    const incPattern = pattern<{ counter: { value: number } }>(
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "should execute handlers", undefined, tx);
    const result = runtime.run(tx, incPattern, {
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

    const incPattern = pattern<{ counter: { value: number } }>(
      ({ counter }) => {
        return { counter, stream: incHandler({ counter }) };
      },
    );

    const resultCell = runtime.getCell<
      { counter: { value: number }; stream: any }
    >(space, "handler source location test", undefined, tx);
    const result = runtime.run(tx, incPattern, {
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
      /^handler:.*patterns-handlers\.test\.ts:\d+:\d+$/,
    );

    addEventHandlerSpy.restore();
  });

  it("should execute patterns returned by handlers", async () => {
    const counter = runtime.getCell<{ value: number }>(
      space,
      "should execute patterns returned by handlers 1",
      undefined,
      tx,
    );
    counter.set({ value: 0 });
    const nested = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should execute patterns returned by handlers 2",
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

    const incPattern = pattern<{
      counter: { value: number };
      nested: { a: { b: { c: number } } };
    }>(({ counter, nested }) => {
      const stream = incHandler({ counter, nested });
      return { stream };
    });

    const resultCell = runtime.getCell<{ stream: any }>(
      space,
      "should execute patterns returned by handlers",
      undefined,
      tx,
    );
    const result = runtime.run(tx, incPattern, {
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

    const incPattern = pattern<{ counter: number }>(
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
    const result = runtime.run(tx, incPattern, {
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

    const divPattern = pattern<{ result: number }>(
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
    const piece = runtime.run(tx, divPattern, { result: 1 }, pieceCell);
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
    const patternId = sourceCellValue?.[TYPE];
    expect(patternId).toBeDefined();
    expect(lastError?.patternId).toBe(patternId);
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
});
