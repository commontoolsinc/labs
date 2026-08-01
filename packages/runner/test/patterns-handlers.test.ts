// Event handlers: defining and invoking handlers, handler metadata,
// handler-produced side effects, schema-annotated handlers, and handler errors.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { setEagerSourceAnnotation } from "../src/builder/module.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getPatternIdentityRef } from "@commonfabric/runner";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Handlers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commonfabric"]["handler"];
  let Writable: ReturnType<typeof createBuilder>["commonfabric"]["Writable"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      lift,
      pattern,
      handler,
      Writable,
    } = commonfabric);
  });

  afterEach(async () => {
    setEagerSourceAnnotation(false);
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

  it("defers handler registration for retryable setup transactions until commit", async () => {
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

    const result = await runtime.editWithRetry((retryTx) => {
      const resultCell = runtime.getCell<
        { counter: { value: number }; stream: any }
      >(space, "defer retryable handler start", undefined, retryTx);
      const cell = runtime.run(retryTx, incPattern, {
        counter: { value: 0 },
      }, resultCell);

      expect(addEventHandlerSpy.calls.length).toBe(0);
      return cell;
    });
    if (result.error) throw new Error(result.error.message);

    await result.ok.pull();

    expect(addEventHandlerSpy.calls.length).toBe(1);

    addEventHandlerSpy.restore();
  });

  it("should propagate handler source location to scheduler via .name", async () => {
    // `.name` source-location propagation is a debug feature; its eager
    // resolution is off by default (the boot lever), so enable it for this test.
    setEagerSourceAnnotation(true);
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

  it("should annotate event handlers with write targets", async () => {
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
    >(space, "handler write target annotation test", undefined, tx);
    const result = runtime.run(tx, incPattern, {
      counter: { value: 0 },
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(addEventHandlerSpy.calls.length).toBeGreaterThan(0);
    const registeredHandler = addEventHandlerSpy.calls[0].args[0] as {
      writes?: unknown[];
    };
    expect(registeredHandler.writes).toBeDefined();

    addEventHandlerSpy.restore();
  });
  it("should demand handler-written pattern results when pulled", async () => {
    const counter = runtime.getCell<{ value: number }>(
      space,
      "should demand handler-written pattern results when pulled 1",
      undefined,
      tx,
    );
    counter.set({ value: 0 });
    const nested = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should demand handler-written pattern results when pulled 2",
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
      {
        counter: { value: number };
        nested: { a: { b: { c: number } } };
        latest?: number[];
      }
    >(
      (event, state) => {
        state.counter.value += event.amount;
        state.latest = incLogger({
          counter: state.counter,
          amount: event.amount,
          nested: state.nested.a.b,
        });
      },
      { proxy: true },
    );

    const incPattern = pattern<{
      counter: { value: number };
      nested: { a: { b: { c: number } } };
    }>(({ counter, nested }) => {
      const latest = Writable.of<number[] | undefined>(undefined);
      const stream = incHandler({ counter, nested, latest });
      return { stream, latest };
    });

    const resultCell = runtime.getCell<{
      stream: any;
      latest?: number[];
    }>(
      space,
      "should demand handler-written pattern results when pulled",
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
    expect(values).toEqual([]);
    expect(await result.key("latest").pull()).toEqual([1, 1, 0]);
    expect(values).toEqual([[1, 1, 0]]);

    result.key("stream").send({ amount: 2 });
    await runtime.idle();

    expect(values).toContainEqual([1, 1, 0]);
    expect(await result.key("latest").pull()).toEqual([3, 2, 0]);
    expect(values).toContainEqual([3, 2, 0]);
    expect(values.some((tuple) => tuple.join(",") === "3,1,0")).toBe(false);

    const graph = runtime.scheduler.getGraphSnapshot();
    expect(
      graph.nodes.some((node) => node.id.startsWith("readResult:")),
    ).toBe(false);
    expect(
      graph.nodes.some((node) => node.id.startsWith("handlerResult:")),
    ).toBe(false);
  });

  it("should execute handlers with schemas", async () => {
    const incHandler = handler<{ amount: number }, { counter: number }>(
      { type: "object", properties: { amount: { type: "number" } } },
      {
        type: "object",
        properties: {
          counter: {
            type: "number",
            asCell: ["cell"],
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

    const patternIdentity = getPatternIdentityRef(piece)?.identity;
    expect(patternIdentity).toBeDefined();
    expect(lastError?.patternId).toBe(patternIdentity);
    expect(lastError?.space).toBe(space);
    // Diagnostics carry the FULL schemed sourceURI (see diagnostics.ts:
    // ids copied from error context paste back into tools without a
    // bare-id round trip).
    expect(lastError?.pieceId).toBe(piece.sourceURI);

    // NOTE(ja): this test is really important after a handler
    // fails the entire system crashes!!!!
    piece.key("updater").send({ divisor: 10, dividend: 5 });
    value = await piece.pull();
    expect(value).toMatchObject({ result: 2 });
  });
});
