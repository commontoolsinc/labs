import { afterEach, beforeEach, describe, it } from "./helpers/tx-bdd.ts";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { type Action, type EventHandler } from "../src/scheduler.ts";
import { compactifyPaths, ignoreReadForScheduling } from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("scheduler", (config) => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it.skip({ useStorageManagerTransactions: true }, "should run actions when cells change", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should run actions when cells change 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions when cells change 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions when cells change 3",
      undefined,
      tx,
    );
    c.set(0);
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    await runtime.scheduler.run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.send(2); // No log, simulate external change
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it.skip({ useStorageManagerTransactions: true }, "schedule shouldn't run immediately", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 3",
      undefined,
      tx,
    );
    c.set(0);
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.schedule(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      writes: [c.getAsNormalizedFullLink()],
    });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.send(2); // No log, simulate external change
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it.skip({ useStorageManagerTransactions: true }, "should remove actions", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should remove actions 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should remove actions 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should remove actions 3",
      undefined,
      tx,
    );
    c.set(0);
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    await runtime.scheduler.run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.send(2);
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    runtime.scheduler.unschedule(adder);
    a.send(3);
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it.skip({ useStorageManagerTransactions: true }, "scheduler should return a cancel function", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 3",
      undefined,
      tx,
    );
    c.set(0);
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const cancel = runtime.scheduler.schedule(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      writes: [c.getAsNormalizedFullLink()],
    });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.send(2);
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.send(3);
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it.skip({ useStorageManagerTransactions: true }, "should run actions in topological order", async () => {
    const runs: string[] = [];
    const a = runtime.getCell<number>(
      space,
      "should run actions in topological order 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions in topological order 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions in topological order 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should run actions in topological order 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should run actions in topological order 5",
      undefined,
      tx,
    );
    e.set(0);
    const adder1: Action = (tx) => {
      runs.push("adder1");
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      runs.push("adder2");
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    await runtime.scheduler.run(adder1);
    await runtime.scheduler.run(adder2);
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.send(2);
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.send(2);
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2,adder1,adder2");
    expect(c.get()).toBe(4);
    expect(e.get()).toBe(6);
  });

  it.skip({ useStorageManagerTransactions: true }, "should stop eventually when encountering infinite loops", async () => {
    let maxRuns = 120; // More than the limit in scheduler
    const a = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 5",
      undefined,
      tx,
    );
    e.set(0);
    const adder1: Action = (tx) => {
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    const adder3: Action = (tx) => {
      if (--maxRuns <= 0) return;
      c.withTx(tx).send(
        e.withTx(tx).get() + b.withTx(tx).get(),
      );
    };

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    await runtime.scheduler.run(adder1);
    await runtime.scheduler.run(adder2);
    await runtime.scheduler.run(adder3);

    await runtime.idle();

    expect(maxRuns).toBeGreaterThan(10);
    assertSpyCall(stopped, 0, undefined);
  });

  it.skip({ useStorageManagerTransactions: true }, "should not loop on r/w changes on its own output", async () => {
    const counter = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 1",
      undefined,
      tx,
    );
    counter.set(0);
    const by = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 2",
      undefined,
      tx,
    );
    by.set(1);
    const inc: Action = (tx) =>
      counter
        .withTx(tx)
        .send(counter.withTx(tx).get() + by.withTx(tx).get());

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    await runtime.scheduler.run(inc);
    expect(counter.get()).toBe(1);
    await runtime.idle();
    expect(counter.get()).toBe(1);

    by.send(2);
    await runtime.idle();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    runtime.scheduler.schedule(inc, { reads: [], writes: [] });
    await runtime.idle();
    expect(runs).toBe(1);
  });

  it.skip({ useStorageManagerTransactions: true }, "should not create dependencies when using getRaw with ignoreReadForScheduling", async () => {
    // Create a source cell that will be read with ignored metadata
    const sourceCell = runtime.getCell<{ value: number }>(
      space,
      "source-cell-for-ignore-test",
      undefined,
      tx,
    );
    sourceCell.set({ value: 1 });

    // Create a result cell to track action runs (avoiding self-dependencies)
    const resultCell = runtime.getCell<{ count: number; lastValue: any }>(
      space,
      "result-cell-for-ignore-test",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, lastValue: null });

    let actionRunCount = 0;
    let lastReadValue: any;

    // Action that ONLY uses ignored reads
    const ignoredReadAction: Action = (actionTx) => {
      actionRunCount++;

      // Read with ignoreReadForScheduling - should NOT create dependency
      lastReadValue = sourceCell.withTx(actionTx).getRaw({
        meta: ignoreReadForScheduling,
      });

      // Write to result cell to track that the action ran
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        lastValue: lastReadValue,
      });
    };

    // Run the action initially
    await runtime.scheduler.run(ignoredReadAction);
    expect(actionRunCount).toBe(1);
    expect(lastReadValue).toEqual({ value: 1 });
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });

    // Change the source cell
    sourceCell.set({ value: 5 });
    await runtime.idle();

    // Action should NOT run again because the read was ignored
    expect(actionRunCount).toBe(1); // Still 1!
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } }); // Unchanged

    // Change the source cell again to be extra sure
    sourceCell.set({ value: 10 });
    await runtime.idle();

    // Still should not have run
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });
  });
});

describe("event handling", (config) => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it.skip({ useStorageManagerTransactions: true }, "should queue and process events", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should queue and process events 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should queue and process events 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    let eventCount = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventResultCell.send(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);

    await runtime.idle();

    expect(eventCount).toBe(2);
    expect(eventCell.get()).toBe(0); // Events are _not_ written to cell
    expect(eventResultCell.get()).toBe(2);
  });

  it.skip({ useStorageManagerTransactions: true }, "should remove event handlers", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should remove event handlers 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    let eventCount = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventCell.send(event);
    };

    const removeHandler = runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);

    removeHandler();

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);
  });

  it.skip({ useStorageManagerTransactions: true }, "should handle events with nested paths", async () => {
    const parentCell = runtime.getCell<{ child: { value: number } }>(
      space,
      "should handle events with nested paths 1",
      undefined,
      tx,
    );
    parentCell.set({ child: { value: 0 } });
    let eventCount = 0;

    const eventHandler: EventHandler = () => {
      eventCount++;
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
      42,
    );
    await runtime.idle();

    expect(eventCount).toBe(1);
  });

  it.skip({ useStorageManagerTransactions: true }, "should process events in order", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should process events in order 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const events: number[] = [];

    const eventHandler: EventHandler = (event) => {
      events.push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 3);

    await runtime.idle();

    expect(events).toEqual([1, 2, 3]);
  });

  it.skip({ useStorageManagerTransactions: true }, "should trigger recomputation of dependent cells", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    let eventCount = 0;
    let actionCount = 0;
    let lastEventSeen = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventResultCell.send(event);
    };

    const action = (tx: IExtendedStorageTransaction) => {
      actionCount++;
      lastEventSeen = eventResultCell.withTx(tx).get();
    };
    await runtime.scheduler.run(action);

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    expect(actionCount).toBe(1);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventResultCell.get()).toBe(1);

    expect(actionCount).toBe(2);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await runtime.idle();

    expect(eventCount).toBe(2);
    expect(eventResultCell.get()).toBe(2);
    expect(actionCount).toBe(3);
    expect(lastEventSeen).toBe(2);
  });
});

describe("compactifyPaths", (config) => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it.skip({ useStorageManagerTransactions: true }, "should compactify paths", () => {
    const testCell = runtime.getCell<Record<string, any>>(
      space,
      "should compactify paths 1",
      undefined,
      tx,
    );
    testCell.set({});
    const paths = [
      testCell.key("a").key("b").getAsNormalizedFullLink(),
      testCell.key("a").getAsNormalizedFullLink(),
      testCell.key("c").getAsNormalizedFullLink(),
    ];
    const result = compactifyPaths(paths);
    const expected = [
      testCell.key("a").getAsNormalizedFullLink(),
      testCell.key("c").getAsNormalizedFullLink(),
    ];
    expect(result).toEqual(expected);
  });

  it.skip({ useStorageManagerTransactions: true }, "should remove duplicate paths", () => {
    const testCell = runtime.getCell<Record<string, any>>(
      space,
      "should remove duplicate paths 1",
      undefined,
      tx,
    );
    testCell.set({});
    const paths = [
      testCell.key("a").key("b").getAsNormalizedFullLink(),
      testCell.key("a").key("b").getAsNormalizedFullLink(),
    ];
    const result = compactifyPaths(paths);
    const expected = [testCell.key("a").key("b").getAsNormalizedFullLink()];
    expect(result).toEqual(expected);
  });

  it.skip({ useStorageManagerTransactions: true }, "should not compactify across cells", () => {
    const cellA = runtime.getCell<Record<string, any>>(
      space,
      "should not compactify across cells 1",
      undefined,
      tx,
    );
    cellA.set({});
    const cellB = runtime.getCell<Record<string, any>>(
      space,
      "should not compactify across cells 2",
      undefined,
      tx,
    );
    cellB.set({});
    const paths = [
      cellA.key("a").key("b").getAsNormalizedFullLink(),
      cellB.key("a").key("b").getAsNormalizedFullLink(),
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual(paths);
  });

  it.skip({ useStorageManagerTransactions: true }, "empty paths should trump all other ones", () => {
    const cellA = runtime.getCell<Record<string, any>>(
      space,
      "should remove duplicate paths 1",
      undefined,
      tx,
    );
    cellA.set({});

    const expectedResult = cellA.getAsNormalizedFullLink();
    const paths = [
      cellA.key("a").key("b").getAsNormalizedFullLink(),
      cellA.key("c").getAsNormalizedFullLink(),
      cellA.key("d").getAsNormalizedFullLink(),
      expectedResult,
    ];
    const result = compactifyPaths(paths);

    expect(result).toEqual([expectedResult]);
  });
});
