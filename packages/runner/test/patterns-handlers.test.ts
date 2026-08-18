// Event handlers: defining and invoking handlers, handler metadata,
// handler-produced side effects, schema-annotated handlers, and handler errors.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getPatternIdentityRef } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { setEagerSourceAnnotation } from "../src/builder/module.ts";
import { type Cell } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

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
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      ({ amount }, { counter }) => {
        const value = counter.key("value");
        value.set(value.get() + amount);
      },
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
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      ({ amount }, { counter }) => {
        const value = counter.key("value");
        value.set(value.get() + amount);
      },
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
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      ({ amount }, { counter }) => {
        const value = counter.key("value");
        value.set(value.get() + amount);
      },
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
      { counter: Cell<{ value: number }> }
    >(
      true,
      {
        type: "object",
        properties: { counter: { type: "object", asCell: ["cell"] } },
      },
      ({ amount }, { counter }) => {
        const value = counter.key("value");
        value.set(value.get() + amount);
      },
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
      { result: Cell<number> }
    >(
      true,
      {
        type: "object",
        properties: { result: { type: "number", asCell: ["cell"] } },
      },
      ({ divisor, dividend }, state) => {
        if (dividend === 0) {
          throw new Error("division by zero");
        }
        state.result.set(divisor / dividend);
      },
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
