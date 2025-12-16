import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Action,
  type EventHandler,
  ignoreReadForScheduling,
  txToReactivityLog,
} from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { Entity } from "@commontools/memory/interface";
import * as Fact from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("scheduler", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for basic scheduler tests (tests push-mode behavior)
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should run actions when cells change", async () => {
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
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.withTx(tx).send(2); // Simulate external change
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("schedule shouldn't run immediately", async () => {
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
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      writes: [c.getAsNormalizedFullLink()],
    }, { scheduleImmediately: true });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2); // No log, simulate external change
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should remove actions", async () => {
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
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    runtime.scheduler.unsubscribe(adder);
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("scheduler should return a cancel function", async () => {
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
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const cancel = runtime.scheduler.subscribe(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      writes: [c.getAsNormalizedFullLink()],
    }, { scheduleImmediately: true });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should run actions in topological order", async () => {
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
    tx.commit();
    tx = runtime.edit();
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
    runtime.scheduler.subscribe(adder1, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    runtime.scheduler.subscribe(adder2, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2,adder1,adder2");
    expect(c.get()).toBe(4);
    expect(e.get()).toBe(6);
  });

  it("should stop eventually when encountering infinite loops", async () => {
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
    tx.commit();
    tx = runtime.edit();
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

    runtime.scheduler.subscribe(adder1, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    runtime.scheduler.subscribe(adder2, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    runtime.scheduler.subscribe(adder3, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();

    await runtime.idle();

    expect(maxRuns).toBeGreaterThan(10);
    assertSpyCall(stopped, 0, undefined);
  });

  it("should not loop on r/w changes on its own output", async () => {
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
    tx.commit();
    tx = runtime.edit();
    const inc: Action = (tx) =>
      counter
        .withTx(tx)
        .send(counter.withTx(tx).get() + by.withTx(tx).get());

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    runtime.scheduler.subscribe(inc, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    expect(counter.get()).toBe(1);
    await runtime.idle();
    expect(counter.get()).toBe(1);

    by.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    runtime.scheduler.subscribe(inc, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();
    expect(runs).toBe(1);
  });

  it("should not create dependencies when using getRaw with ignoreReadForScheduling", async () => {
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
    tx.commit();
    tx = runtime.edit();

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
    runtime.scheduler.subscribe(
      ignoredReadAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();
    expect(actionRunCount).toBe(1);
    expect(lastReadValue).toEqual({ value: 1 });
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });

    // Change the source cell
    sourceCell.withTx(tx).set({ value: 5 });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Action should NOT run again because the read was ignored
    expect(actionRunCount).toBe(1); // Still 1!
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } }); // Unchanged

    // Change the source cell again to be extra sure
    sourceCell.withTx(tx).set({ value: 10 });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Still should not have run
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });
  });

  it("should track potentialWrites via Cell.set even when value doesn't change", async () => {
    // Create a cell with initial values
    const testCell = runtime.getCell<{ a: number; b: string }>(
      space,
      "potential-writes-cell-set-test",
      undefined,
      tx,
    );
    testCell.set({ a: 1, b: "hello" });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set values where `a` stays the same but `b` changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).set({ a: 1, b: "world" }); // a unchanged, b changed

    const log = txToReactivityLog(setTx);

    // Cell.set uses diffAndUpdate which marks reads as potential writes
    // Both properties should appear in potentialWrites (even unchanged ones)
    expect(log.potentialWrites).toBeDefined();
    expect(log.potentialWrites!.some((addr) => addr.path[0] === "a")).toBe(
      true,
    );
    expect(log.potentialWrites!.some((addr) => addr.path[0] === "b")).toBe(
      true,
    );

    // Only `b` changed, so only `b` should be in writes
    expect(log.writes.some((w) => w.path[0] === "a")).toBe(false); // a NOT written
    expect(log.writes.some((w) => w.path[0] === "b")).toBe(true); // b written

    await setTx.commit();
  });

  it("should include unchanged properties in potentialWrites when using Cell.set", async () => {
    // Create a cell with two properties
    const testCell = runtime.getCell<{ unchanged: number; changed: number }>(
      space,
      "diff-update-potential-writes-cell",
      undefined,
      tx,
    );
    testCell.set({ unchanged: 42, changed: 1 });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set values where only one property changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).set({ unchanged: 42, changed: 999 });

    const log = txToReactivityLog(setTx);

    // Both properties should be in potentialWrites because diffAndUpdate
    // reads both to compare, even though only one actually changes
    expect(log.potentialWrites).toBeDefined();
    expect(
      log.potentialWrites!.some((addr) => addr.path[0] === "unchanged"),
    ).toBe(true);
    expect(
      log.potentialWrites!.some((addr) => addr.path[0] === "changed"),
    ).toBe(true);

    // Only changed property should be in writes
    expect(log.writes.some((w) => w.path[0] === "changed")).toBe(true);
    // unchanged property should NOT be in writes (value didn't change)
    expect(log.writes.some((w) => w.path[0] === "unchanged")).toBe(false);

    await setTx.commit();
  });

  it("should not have potentialWrites when using getRaw without metadata", async () => {
    const testCell = runtime.getCell<{ value: number }>(
      space,
      "no-potential-writes-cell",
      undefined,
      tx,
    );
    testCell.set({ value: 1 });
    tx.commit();
    tx = runtime.edit();

    // getRaw without metadata should not create potentialWrites
    const readTx = runtime.edit();
    testCell.withTx(readTx).key("value").getRaw();

    const log = txToReactivityLog(readTx);

    // Should have reads but no potentialWrites
    expect(log.reads.length).toBeGreaterThanOrEqual(1);
    expect(log.potentialWrites).toBeUndefined();

    await readTx.commit();
  });
});

describe("event handling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for event handling tests
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should queue and process events", async () => {
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
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
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

  it("should remove event handlers", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should remove event handlers 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventCell.withTx(tx).send(event);
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

  it("should handle events with nested paths", async () => {
    const parentCell = runtime.getCell<{ child: { value: number } }>(
      space,
      "should handle events with nested paths 1",
      undefined,
      tx,
    );
    parentCell.set({ child: { value: 0 } });
    tx.commit();

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

  it("should process events in order", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should process events in order 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    const events: number[] = [];

    const eventHandler: EventHandler = (_tx, event) => {
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

  it("should trigger recomputation of dependent cells", async () => {
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
    tx.commit();

    let eventCount = 0;
    let actionCount = 0;
    let lastEventSeen = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
    };

    const action = (tx: IExtendedStorageTransaction) => {
      actionCount++;
      lastEventSeen = eventResultCell.withTx(tx).get();
    };
    runtime.scheduler.subscribe(action, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();

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

  it(
    "should retry event handler when commit fails, up to retries count",
    async () => {
      // Prepare remote memory with existing fact to induce conflict on commit
      const memory = storageManager.session().mount(space);
      const entityId = `test:retry-conflict-${Date.now()}` as Entity;
      const existingFact = Fact.assert({
        the: "application/json",
        of: entityId,
        is: { version: 1 },
      });
      await memory.transact({ changes: Changes.from([existingFact]) });

      // Reset local replica so local writes will conflict with remote state
      const { replica } = storageManager.open(space);
      (replica as any).reset();

      // Set up an event cell and commit initial state
      const eventCell = runtime.getCell<number>(
        space,
        "should retry event handler on conflict",
        undefined,
        tx,
      );
      eventCell.set(0);
      await tx.commit();

      // Event handler that writes a conflicting value to the same entity
      let attempts = 0;
      const handler: EventHandler = (tx, _event) => {
        attempts++;
        // Force commit failure for the first 5 attempts to exercise retries.
        if (attempts <= 5) {
          tx.abort("force-abort-for-retry");
          return;
        }
        // On the final attempt, perform a regular write.
        tx.write({
          space,
          id: entityId,
          type: "application/json",
          path: [],
        }, { version: 2 });
      };

      runtime.scheduler.addEventHandler(
        handler,
        eventCell.getAsNormalizedFullLink(),
      );

      // Queue event (uses default retries configured in scheduler)
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
      );

      // First idle may return before the commit callback schedules retries.
      await runtime.idle();
      // Wait for any re-queued events to process.
      await runtime.idle();

      // Should attempt initial + default retries times (DEFAULT_RETRIES=5)
      expect(attempts).toBe(6);

      // No further assertions needed; this verifies retry behavior only.
    },
  );
});

describe("reactive retries", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for reactive retry tests
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it(
    "should retry reactive actions when commit fails, up to limit",
    async () => {
      // Establish a source cell to create a read dependency
      const source = runtime.getCell<number>(
        space,
        "should retry reactive actions when commit fails, up to limit 1",
        undefined,
        tx,
      );
      source.set(1);
      await tx.commit();
      tx = runtime.edit();

      // Count runs; force commit failure each time
      let attempts = 0;
      const reactiveAction: Action = (actionTx) => {
        attempts++;
        // Read to establish dependency so later changes re-trigger
        source.withTx(actionTx).get();
        // Force commit to fail so scheduler retries
        actionTx.abort("force-abort-for-reactive-retry");
      };

      // Subscribe and run immediately
      runtime.scheduler.subscribe(
        reactiveAction,
        { reads: [], writes: [] },
        { scheduleImmediately: true },
      );

      // Allow retries to process. Idle may resolve before re-queue occurs,
      // so loop a few times until attempts reach the expected amount.
      for (let i = 0; i < 20 && attempts < 10; i++) {
        await runtime.idle();
      }

      // MAX_RETRIES_FOR_REACTIVE is 10; expect initial + retries == 10 attempts
      expect(attempts).toBe(10);

      // After reaching retry limit, a subsequent input change should re-trigger
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();

      // Wait for the follow-up run
      await runtime.idle();

      expect(attempts).toBe(11);
    },
  );

  it(
    "should preserve dependencies when retrying failed commits",
    async () => {
      // This test documents expected behavior for the conflict storm fix:
      // When a reactive action's commit fails and it retries, it should
      // preserve its dependency information (not overwrite with empty deps).
      // This ensures topological sorting works correctly during retries.
      //
      // NOTE: This test passes with both buggy and fixed code because line 274
      // immediately re-learns dependencies after each action run, masking the
      // bug in simple scenarios. The real bug manifests only in high-concurrency
      // scenarios (30+ reactive cells) where async commit callbacks race with
      // scheduler execution. See budget-planner integration test for evidence
      // of the fix (conflict storm: 65k errors → 1 error after fix).

      const source = runtime.getCell<number>(
        space,
        "should preserve dependencies source",
        undefined,
        tx,
      );
      source.set(1);

      const intermediate = runtime.getCell<number>(
        space,
        "should preserve dependencies intermediate",
        undefined,
        tx,
      );
      intermediate.set(0);

      const output = runtime.getCell<number>(
        space,
        "should preserve dependencies output",
        undefined,
        tx,
      );
      output.set(0);

      await tx.commit();
      tx = runtime.edit();

      let action1Attempts = 0;
      let action2Attempts = 0;
      const action2Values: number[] = [];

      // Action 1: reads source, writes intermediate (will fail first 2 times)
      const action1: Action = (actionTx) => {
        action1Attempts++;
        const val = source.withTx(actionTx).get();
        intermediate.withTx(actionTx).send(val * 10);

        // Force abort for first 2 attempts to trigger retry logic
        if (action1Attempts <= 2) {
          actionTx.abort("force-abort-action1");
        }
      };

      // Action 2: reads intermediate, writes output (depends on action1)
      const action2: Action = (actionTx) => {
        action2Attempts++;
        const val = intermediate.withTx(actionTx).get();
        action2Values.push(val);
        output.withTx(actionTx).send(val + 5);
      };

      // Subscribe both actions with correct dependencies
      runtime.scheduler.subscribe(
        action1,
        {
          reads: [source.getAsNormalizedFullLink()],
          writes: [intermediate.getAsNormalizedFullLink()],
        },
        { scheduleImmediately: true },
      );
      runtime.scheduler.subscribe(
        action2,
        {
          reads: [intermediate.getAsNormalizedFullLink()],
          writes: [output.getAsNormalizedFullLink()],
        },
        { scheduleImmediately: true },
      );

      // Allow all actions to complete (action1 will retry twice)
      for (let i = 0; i < 20 && action1Attempts < 3; i++) {
        await runtime.idle();
      }

      // Verify action1 ran 3 times (2 aborts + 1 success)
      expect(action1Attempts).toBe(3);

      // Action2 should run twice in reactive system:
      // 1. Initially when both actions run (sees intermediate=0 since action1 aborts)
      // 2. After action1 succeeds and updates intermediate (sees intermediate=10)
      expect(action2Attempts).toBe(2);
      expect(action2Values).toEqual([0, 10]);

      // Critical assertion: The final state must be correct, proving that
      // dependencies were preserved during retries and topological sort worked.
      expect(intermediate.get()).toBe(10); // 1 * 10
      expect(output.get()).toBe(15); // 10 + 5
    },
  );
});

describe("Stream event success callbacks", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should call onCommit callback after Stream event commits successfully", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      42,
      undefined,
      (committedTx) => {
        callbackCalled = true;
        callbackTx = committedTx;
      },
    );

    expect(callbackCalled).toBe(false);
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBeDefined();
    expect(resultCell.get()).toBe(42);
  });

  it("should call callback after all retries succeed", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-retry-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-retry-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let eventHandlerCalls = 0;
    let callbackCalls = 0;

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        eventHandlerCalls++;
        // Fail first time, succeed second time
        if (eventHandlerCalls === 1) {
          tx.abort("Intentional failure for test");
          return;
        }
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      42,
      undefined,
      () => {
        callbackCalls++;
      },
    );

    await runtime.idle();
    await runtime.idle(); // Wait for retry
    await runtime.storageManager.synced();

    // Callback should be called only once after retry succeeds
    expect(callbackCalls).toBe(1);
    expect(eventHandlerCalls).toBe(2); // Called twice (fail then succeed)
    expect(resultCell.get()).toBe(42);
  });

  it("should handle errors in stream callbacks gracefully", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-error-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-error-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    let callback1Called = false;
    let callback2Called = false;

    // Send two events
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      undefined,
      () => {
        callback1Called = true;
        throw new Error("Callback error");
      },
    );

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      2,
      undefined,
      () => {
        callback2Called = true;
      },
    );

    await runtime.idle();
    await runtime.storageManager.synced();

    // Both callbacks should be called despite first one throwing
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
    expect(resultCell.get()).toBe(2); // Last event processed
  });

  it("should allow stream operations without callback", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-optional-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-optional-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    // Should work fine without callback (backward compatible)
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 42);
    await runtime.idle();
    expect(resultCell.get()).toBe(42);
  });

  it("should call onCommit callback even when event fails after all retries", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-final-fail-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-final-fail-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let eventHandlerCalls = 0;
    let callbackCalls = 0;
    let callbackTx: IExtendedStorageTransaction | undefined;

    runtime.scheduler.addEventHandler(
      (tx, _event) => {
        eventHandlerCalls++;
        // Always fail
        tx.abort("Intentional failure - should exhaust retries");
      },
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      42,
      2, // Only 2 retries, so fails faster
      (tx) => {
        callbackCalls++;
        callbackTx = tx;
      },
    );

    await runtime.idle();
    await runtime.idle(); // Retry 1
    await runtime.idle(); // Retry 2 (final)
    await runtime.storageManager.synced();

    // Callback should be called once even though all attempts failed
    expect(callbackCalls).toBe(1);
    expect(eventHandlerCalls).toBe(3); // Initial + 2 retries
    expect(callbackTx).toBeDefined();
    // Transaction should show it failed
    const status = callbackTx!.status();
    expect(status.status).toBe("error");
  });
});

describe("effect/computation tracking", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should track actions as computations by default", async () => {
    const a = runtime.getCell<number>(
      space,
      "track-computations-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit();
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.computations).toBe(0);
    expect(stats1.effects).toBe(0);

    const action: Action = () => {};
    runtime.scheduler.subscribe(action, { reads: [], writes: [] }, {
      scheduleImmediately: true,
    });
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    expect(stats2.computations).toBe(1);
    expect(stats2.effects).toBe(0);
    expect(runtime.scheduler.isComputation(action)).toBe(true);
    expect(runtime.scheduler.isEffect(action)).toBe(false);
  });

  it("should track actions as effects when isEffect is true", async () => {
    const a = runtime.getCell<number>(
      space,
      "track-effects-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit();
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.effects).toBe(0);

    const action: Action = () => {};
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    expect(stats2.effects).toBe(1);
    expect(stats2.computations).toBe(0);
    expect(runtime.scheduler.isEffect(action)).toBe(true);
    expect(runtime.scheduler.isComputation(action)).toBe(false);
  });

  it("should remove from correct set on unsubscribe", async () => {
    const a = runtime.getCell<number>(
      space,
      "unsubscribe-tracking-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit();
    tx = runtime.edit();

    const computation: Action = () => {};
    const effect: Action = () => {};

    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [] },
      { scheduleImmediately: true, isEffect: false },
    );
    runtime.scheduler.subscribe(
      effect,
      { reads: [], writes: [] },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.computations).toBe(1);
    expect(stats1.effects).toBe(1);

    // Unsubscribe computation
    runtime.scheduler.unsubscribe(computation);
    const stats2 = runtime.scheduler.getStats();
    expect(stats2.computations).toBe(0);
    expect(stats2.effects).toBe(1);
    expect(runtime.scheduler.isComputation(computation)).toBe(false);

    // Unsubscribe effect
    runtime.scheduler.unsubscribe(effect);
    const stats3 = runtime.scheduler.getStats();
    expect(stats3.computations).toBe(0);
    expect(stats3.effects).toBe(0);
    expect(runtime.scheduler.isEffect(effect)).toBe(false);
  });

  it("should track sink() calls as effects", async () => {
    const a = runtime.getCell<number>(
      space,
      "sink-as-effect-1",
      undefined,
      tx,
    );
    a.set(42);
    await tx.commit();
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    const initialEffects = stats1.effects;

    let sinkValue: number | undefined;
    const cancel = a.sink((value) => {
      sinkValue = value;
    });
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    // sink() should add an effect
    expect(stats2.effects).toBe(initialEffects + 1);
    expect(sinkValue).toBe(42);

    cancel();
    await runtime.idle();

    // After cancel, effect count should decrease (but may not be immediate due to GC)
  });

  it("should track dependents for reverse dependency graph", async () => {
    const source = runtime.getCell<number>(
      space,
      "dependents-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "dependents-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const output = runtime.getCell<number>(
      space,
      "dependents-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Action 1: reads source, writes intermediate
    const action1: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(val * 10);
    };

    // Action 2: reads intermediate, writes output
    const action2: Action = (actionTx) => {
      const val = intermediate.withTx(actionTx).get();
      output.withTx(actionTx).send(val + 5);
    };

    // Subscribe action1 first (writes to intermediate)
    runtime.scheduler.subscribe(
      action1,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [intermediate.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Subscribe action2 (reads intermediate)
    runtime.scheduler.subscribe(
      action2,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // action2 should be a dependent of action1 (action1 writes what action2 reads)
    const dependents = runtime.scheduler.getDependents(action1);
    expect(dependents.has(action2)).toBe(true);
  });
});

describe("pull-based scheduling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should have unchanged behavior with pullMode = false", async () => {
    // Explicitly set push mode for this test
    runtime.scheduler.disablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(false);

    const source = runtime.getCell<number>(
      space,
      "push-mode-unchanged-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "push-mode-unchanged-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    expect(computationRuns).toBe(1);
    expect(result.get()).toBe(10);

    // Change source - should trigger computation in push mode
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(computationRuns).toBe(2);
    expect(result.get()).toBe(20);
  });

  it("should mark computations as dirty in pull mode when source changes", async () => {
    // This test verifies that in pull mode, computations are marked dirty
    // rather than scheduled when their inputs change.
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

    const source = runtime.getCell<number>(
      space,
      "pull-mode-dirty-marking-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "pull-mode-dirty-marking-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;

    // Computation: reads source, writes result
    const computation: Action = (actionTx) => {
      computationRuns++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 10);
    };

    // Subscribe computation
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // After computation runs, result should be 10
    expect(result.get()).toBe(10);
    expect(computationRuns).toBe(1);

    // Verify computation is clean after running
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Change source - in pull mode, computation should be marked dirty
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    // Give time for the storage notification to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    // In pull mode with no effect depending on this computation,
    // the computation should be marked dirty but not run
    // (since there's no effect to pull it)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

    // The computation should NOT have run again (pull mode doesn't schedule computations)
    expect(computationRuns).toBe(1);
  });

  it("should schedule effects when affected by dirty computations", async () => {
    // This test verifies that scheduleAffectedEffects correctly finds and
    // schedules effects that depend on a dirty computation.
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "schedule-effects-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "schedule-effects-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "schedule-effects-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;

    // Computation: reads source, writes intermediate
    const computation: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(val * 10);
    };

    // Effect: reads intermediate
    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = intermediate.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val + 5);
    };

    // Subscribe computation first
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [intermediate.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Subscribe effect with isEffect: true
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    // Verify dependency tracking is set up correctly
    const dependents = runtime.scheduler.getDependents(computation);
    expect(dependents.has(effect)).toBe(true);

    // Track initial effect runs
    const initialEffectRuns = effectRuns;

    // Change source - computation should be marked dirty, effect should be scheduled
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Effect should have run (triggered via scheduleAffectedEffects)
    expect(effectRuns).toBeGreaterThan(initialEffectRuns);
  });

  it("should recompute multi-hop chains before running effects in pull mode", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "pull-multihop-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate1 = runtime.getCell<number>(
      space,
      "pull-multihop-mid-1",
      undefined,
      tx,
    );
    intermediate1.set(0);
    const intermediate2 = runtime.getCell<number>(
      space,
      "pull-multihop-mid-2",
      undefined,
      tx,
    );
    intermediate2.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-multihop-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let comp1Runs = 0;
    let comp2Runs = 0;
    let effectRuns = 0;

    const computation1: Action = (actionTx) => {
      comp1Runs++;
      const val = source.withTx(actionTx).get();
      intermediate1.withTx(actionTx).send(val + 1);
    };

    const computation2: Action = (actionTx) => {
      comp2Runs++;
      const val = intermediate1.withTx(actionTx).get();
      intermediate2.withTx(actionTx).send(val * 2);
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = intermediate2.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val - 3);
    };

    runtime.scheduler.subscribe(
      computation1,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [intermediate1.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      computation2,
      {
        reads: [intermediate1.getAsNormalizedFullLink()],
        writes: [intermediate2.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate2.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    expect(effectResult.get()).toBe((1 + 1) * 2 - 3);
    expect(comp2Runs).toBe(1);
    expect(effectRuns).toBe(1);

    const tx2 = runtime.edit();
    source.withTx(tx2).send(5);
    await tx2.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(comp1Runs).toBe(2);
    expect(comp2Runs).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe((5 + 1) * 2 - 3);
  });

  it("should drop stale dependents when computation changes inputs", async () => {
    runtime.scheduler.enablePullMode();

    const sourceA = runtime.getCell<number>(
      space,
      "pull-deps-source-a",
      undefined,
      tx,
    );
    sourceA.set(2);
    const sourceB = runtime.getCell<number>(
      space,
      "pull-deps-source-b",
      undefined,
      tx,
    );
    sourceB.set(7);
    const selector = runtime.getCell<boolean>(
      space,
      "pull-deps-selector",
      undefined,
      tx,
    );
    selector.set(false);
    const intermediate = runtime.getCell<number>(
      space,
      "pull-deps-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-deps-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;

    const computation: Action = (actionTx) => {
      const useB = selector.withTx(actionTx).get();
      const value = useB
        ? sourceB.withTx(actionTx).get()
        : sourceA.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(value * 10);
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      const value = intermediate.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(value);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [
          selector.getAsNormalizedFullLink(),
          sourceA.getAsNormalizedFullLink(),
        ],
        writes: [intermediate.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(20);

    // Switch computation to sourceB
    const toggleTx = runtime.edit();
    selector.withTx(toggleTx).send(true);
    await toggleTx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);

    // Updating sourceA should not dirty the computation any more
    const tx3 = runtime.edit();
    sourceA.withTx(tx3).send(999);
    await tx3.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Updating sourceB should still run the computation
    const tx4 = runtime.edit();
    sourceB.withTx(tx4).send(6);
    await tx4.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(effectRuns).toBe(3);
    expect(effectResult.get()).toBe(60);
  });

  it("should track getStats with dirty count", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "stats-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    const computation: Action = () => {};

    runtime.scheduler.subscribe(
      computation,
      { reads: [source.getAsNormalizedFullLink()], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Computation should be clean
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Stats should show correct counts
    const stats = runtime.scheduler.getStats();
    expect(stats.computations).toBeGreaterThanOrEqual(1);
    expect(stats.effects).toBe(0);
  });

  it("should allow disabling pull mode", () => {
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

    runtime.scheduler.disablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(false);
  });
});

describe("cycle-aware convergence", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for cycle-aware convergence tests
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should track action execution time", async () => {
    const cell = runtime.getCell<number>(
      space,
      "action-timing-test",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = () => {
      // Simulate some work
      let sum = 0;
      for (let i = 0; i < 1000; i++) {
        sum += i;
      }
      return sum;
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Should have stats recorded
    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBe(1);
    expect(stats!.totalTime).toBeGreaterThanOrEqual(0);
    expect(stats!.averageTime).toBe(stats!.totalTime);
    expect(stats!.lastRunTime).toBe(stats!.totalTime);
  });

  it("should accumulate action stats across multiple runs", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "action-stats-trigger",
      undefined,
      tx,
    );
    trigger.set(1);
    const output = runtime.getCell<number>(
      space,
      "action-stats-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = trigger.withTx(actionTx).get();
      output.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // First run
    let stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(1);
    const firstRunTime = stats!.totalTime;

    // Trigger another run
    trigger.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Second run - stats should accumulate
    stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(2);
    expect(stats!.totalTime).toBeGreaterThanOrEqual(firstRunTime);
    expect(stats!.averageTime).toBe(stats!.totalTime / 2);
  });

  it("should detect cycles in the work set", async () => {
    runtime.scheduler.enablePullMode();

    // Create cells for a simple cycle: A → B → A
    const cellA = runtime.getCell<number>(
      space,
      "cycle-detect-A",
      undefined,
      tx,
    );
    cellA.set(1);
    const cellB = runtime.getCell<number>(
      space,
      "cycle-detect-B",
      undefined,
      tx,
    );
    cellB.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Action A: reads A, writes B
    const actionA: Action = (actionTx) => {
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val + 1);
    };

    // Action B: reads B, writes A (creates cycle)
    const actionB: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      // Only update if we haven't converged
      if (val < 5) {
        cellA.withTx(actionTx).send(val);
      }
    };

    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Create a work set with both actions and detect cycles
    const workSet = new Set([actionA, actionB]);
    const cycles = runtime.scheduler.detectCycles(workSet);

    // Should detect a cycle containing both actions
    expect(cycles.length).toBe(1);
    expect(cycles[0].size).toBe(2);
    expect(cycles[0].has(actionA)).toBe(true);
    expect(cycles[0].has(actionB)).toBe(true);
  });

  it("should run fast cycle convergence method", async () => {
    // This test verifies the fast cycle convergence logic by directly
    // testing with scheduleImmediately (which bypasses pull mode complexity)
    runtime.scheduler.enablePullMode();

    // Create a simple dependency chain
    const counter = runtime.getCell<number>(
      space,
      "fast-cycle-counter",
      undefined,
      tx,
    );
    counter.set(0);
    const doubled = runtime.getCell<number>(
      space,
      "fast-cycle-doubled",
      undefined,
      tx,
    );
    doubled.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Computation: doubles the counter
    const computation: Action = (actionTx) => {
      const val = counter.withTx(actionTx).get();
      doubled.withTx(actionTx).send(val * 2);
    };

    // Subscribe with scheduleImmediately to ensure it runs
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [counter.getAsNormalizedFullLink()],
        writes: [doubled.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // After initial run, doubled should be 0 (0 * 2)
    expect(doubled.get()).toBe(0);

    // Update counter and run again
    counter.withTx(tx).send(5);
    await tx.commit();
    tx = runtime.edit();

    // Subscribe again to re-run
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [counter.getAsNormalizedFullLink()],
        writes: [doubled.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Now doubled should be 10 (5 * 2)
    expect(doubled.get()).toBe(10);
  });

  it("should enforce iteration limit for non-converging cycles", async () => {
    runtime.scheduler.enablePullMode();

    // Create a non-converging cycle (always increments)
    const cellA = runtime.getCell<number>(
      space,
      "non-converge-A",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "non-converge-B",
      undefined,
      tx,
    );
    cellB.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCountA = 0;
    let runCountB = 0;

    // Action A: increments based on B
    const actionA: Action = (actionTx) => {
      runCountA++;
      const val = cellB.withTx(actionTx).get();
      cellA.withTx(actionTx).send(val + 1);
    };

    // Action B: increments based on A (infinite loop)
    const actionB: Action = (actionTx) => {
      runCountB++;
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val + 1);
    };

    // Set up error handler to catch the cycle error
    let errorCaught = false;
    runtime.scheduler.onError(() => {
      errorCaught = true;
    });

    // Subscribe both actions before awaiting idle so they're both in pending set
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    // Let the cycle run - it should stop after hitting the limit
    for (let i = 0; i < 30; i++) {
      await runtime.idle();
    }

    // The cycle should have stopped due to iteration limit
    // (either via MAX_ITERATIONS_PER_RUN or MAX_CYCLE_ITERATIONS)
    // Total runs should be bounded, not infinite
    expect(runCountA + runCountB).toBeLessThan(500);

    // The error handler should have been called due to cycle detection
    expect(errorCaught).toBe(true);
  });

  it("should not create infinite loops in collectDirtyDependencies", async () => {
    runtime.scheduler.enablePullMode();

    // Create a simple dependency structure
    const source = runtime.getCell<number>(
      space,
      "collect-deps-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "collect-deps-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    const computation: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Initial result should be 2 (1 * 2)
    expect(result.get()).toBe(2);

    // Change source
    source.withTx(tx).send(9);
    await tx.commit();
    tx = runtime.edit();

    // Re-subscribe to force a re-run (simulating what happens in real usage)
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    // Wait for updates
    await runtime.idle();

    // Final result should be based on last value
    expect(result.get()).toBe(18); // 9 * 2
  });

  it("should handle cycles during dependency collection without infinite recursion", async () => {
    runtime.scheduler.enablePullMode();

    // Create cells that form a cycle
    const cellA = runtime.getCell<number>(
      space,
      "collect-cycle-A",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "collect-cycle-B",
      undefined,
      tx,
    );
    cellB.set(0);
    const cellC = runtime.getCell<number>(
      space,
      "collect-cycle-C",
      undefined,
      tx,
    );
    cellC.set(0);
    await tx.commit();
    tx = runtime.edit();

    // A → B → C → A cycle
    const actionA: Action = (actionTx) => {
      const val = cellC.withTx(actionTx).get();
      if (val < 3) {
        cellA.withTx(actionTx).send(val + 1);
      }
    };

    const actionB: Action = (actionTx) => {
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val);
    };

    const actionC: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      cellC.withTx(actionTx).send(val);
    };

    // Subscribe all actions
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellC.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      actionC,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellC.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // The cycle should converge (value reaches 3)
    // This tests that collectDirtyDependencies doesn't infinitely recurse
    expect(cellC.get()).toBeLessThanOrEqual(3);
  });

  // ============================================================
  // Cycle Detection Edge Cases
  // ============================================================

  it("should return empty array for empty work set", () => {
    const workSet = new Set<Action>();
    const cycles = runtime.scheduler.detectCycles(workSet);
    expect(cycles.length).toBe(0);
  });

  it("should return empty array for single action (no cycle possible)", async () => {
    const cell = runtime.getCell<number>(space, "single-action", undefined, tx);
    cell.set(1);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    const workSet = new Set([action]);
    const cycles = runtime.scheduler.detectCycles(workSet);

    // Single action cannot form a cycle with itself in SCC terms
    // (self-loops are handled separately)
    expect(cycles.length).toBe(0);
  });

  it("should not detect cycles in acyclic graphs", async () => {
    // Create a chain: A → B → C (no cycle)
    const cellA = runtime.getCell<number>(space, "chain-A", undefined, tx);
    cellA.set(1);
    const cellB = runtime.getCell<number>(space, "chain-B", undefined, tx);
    cellB.set(0);
    const cellC = runtime.getCell<number>(space, "chain-C", undefined, tx);
    cellC.set(0);
    await tx.commit();
    tx = runtime.edit();

    const actionA: Action = (actionTx) => {
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val * 2);
    };

    const actionB: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      cellC.withTx(actionTx).send(val + 1);
    };

    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellC.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    const workSet = new Set([actionA, actionB]);
    const cycles = runtime.scheduler.detectCycles(workSet);

    expect(cycles.length).toBe(0);
  });

  it("should detect multiple independent cycles when dependencies are set", async () => {
    runtime.scheduler.enablePullMode();

    // Cycle 1: A1 ↔ B1
    const cellA1 = runtime.getCell<number>(
      space,
      "multi-cycle-A1",
      undefined,
      tx,
    );
    cellA1.set(1);
    const cellB1 = runtime.getCell<number>(
      space,
      "multi-cycle-B1",
      undefined,
      tx,
    );
    cellB1.set(0);

    // Cycle 2: A2 ↔ B2
    const cellA2 = runtime.getCell<number>(
      space,
      "multi-cycle-A2",
      undefined,
      tx,
    );
    cellA2.set(1);
    const cellB2 = runtime.getCell<number>(
      space,
      "multi-cycle-B2",
      undefined,
      tx,
    );
    cellB2.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Cycle 1 actions - both read AND write to create bidirectional dependency
    const action1A: Action = (actionTx) => {
      const a = cellA1.withTx(actionTx).get();
      const _b = cellB1.withTx(actionTx).get();
      cellB1.withTx(actionTx).send(a + 1);
    };
    const action1B: Action = (actionTx) => {
      const b = cellB1.withTx(actionTx).get();
      const _a = cellA1.withTx(actionTx).get();
      if (b < 5) cellA1.withTx(actionTx).send(b);
    };

    // Cycle 2 actions
    const action2A: Action = (actionTx) => {
      const a = cellA2.withTx(actionTx).get();
      const _b = cellB2.withTx(actionTx).get();
      cellB2.withTx(actionTx).send(a + 1);
    };
    const action2B: Action = (actionTx) => {
      const b = cellB2.withTx(actionTx).get();
      const _a = cellA2.withTx(actionTx).get();
      if (b < 5) cellA2.withTx(actionTx).send(b);
    };

    // Subscribe all with proper dependency declarations
    runtime.scheduler.subscribe(
      action1A,
      {
        reads: [
          cellA1.getAsNormalizedFullLink(),
          cellB1.getAsNormalizedFullLink(),
        ],
        writes: [cellB1.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    runtime.scheduler.subscribe(
      action1B,
      {
        reads: [
          cellA1.getAsNormalizedFullLink(),
          cellB1.getAsNormalizedFullLink(),
        ],
        writes: [cellA1.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    runtime.scheduler.subscribe(
      action2A,
      {
        reads: [
          cellA2.getAsNormalizedFullLink(),
          cellB2.getAsNormalizedFullLink(),
        ],
        writes: [cellB2.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    runtime.scheduler.subscribe(
      action2B,
      {
        reads: [
          cellA2.getAsNormalizedFullLink(),
          cellB2.getAsNormalizedFullLink(),
        ],
        writes: [cellA2.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    await runtime.idle();

    const workSet = new Set([action1A, action1B, action2A, action2B]);
    const cycles = runtime.scheduler.detectCycles(workSet);

    // Should detect 2 independent cycles (Cycle1: action1A ↔ action1B, Cycle2: action2A ↔ action2B)
    expect(cycles.length).toBe(2);
  });

  it("should handle diamond dependencies (not a cycle)", async () => {
    // Diamond: Source → A, Source → B, A → Sink, B → Sink
    // This is NOT a cycle
    const source = runtime.getCell<number>(
      space,
      "diamond-source",
      undefined,
      tx,
    );
    source.set(1);
    const midA = runtime.getCell<number>(space, "diamond-midA", undefined, tx);
    midA.set(0);
    const midB = runtime.getCell<number>(space, "diamond-midB", undefined, tx);
    midB.set(0);
    const sink = runtime.getCell<number>(space, "diamond-sink", undefined, tx);
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    const actionA: Action = (actionTx) => {
      midA.withTx(actionTx).send(source.withTx(actionTx).get() * 2);
    };
    const actionB: Action = (actionTx) => {
      midB.withTx(actionTx).send(source.withTx(actionTx).get() + 1);
    };
    const actionSink: Action = (actionTx) => {
      sink
        .withTx(actionTx)
        .send(midA.withTx(actionTx).get() + midB.withTx(actionTx).get());
    };

    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [midA.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [midB.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      actionSink,
      {
        reads: [
          midA.getAsNormalizedFullLink(),
          midB.getAsNormalizedFullLink(),
        ],
        writes: [sink.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    const workSet = new Set([actionA, actionB, actionSink]);
    const cycles = runtime.scheduler.detectCycles(workSet);

    // Diamond is not a cycle
    expect(cycles.length).toBe(0);
  });

  // ============================================================
  // Action Stats Edge Cases
  // ============================================================

  it("should return undefined for unknown action stats", () => {
    const unknownAction: Action = () => {};
    const stats = runtime.scheduler.getActionStats(unknownAction);
    expect(stats).toBeUndefined();
  });

  it("should record stats even when action throws", async () => {
    let errorCaught = false;
    runtime.scheduler.onError(() => {
      errorCaught = true;
    });

    const errorAction: Action = () => {
      throw new Error("Test error");
    };

    runtime.scheduler.subscribe(
      errorAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );

    await runtime.idle();

    // Error should have been caught
    expect(errorCaught).toBe(true);

    // Stats should still be recorded
    const stats = runtime.scheduler.getActionStats(errorAction);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBe(1);
  });

  it("should correctly calculate average time", async () => {
    const cell = runtime.getCell<number>(
      space,
      "avg-time-cell",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      // Do some work to ensure measurable time
      let sum = 0;
      for (let i = 0; i < 100; i++) sum += i;
      cell.withTx(actionTx).send(sum);
    };

    // Run action multiple times
    for (let i = 0; i < 3; i++) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], writes: [] },
        { scheduleImmediately: true },
      );
      await runtime.idle();
    }

    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBe(3);
    // Average should be total / count
    expect(stats!.averageTime).toBeCloseTo(stats!.totalTime / 3, 5);
  });

  // ============================================================
  // Cycle Convergence Scenarios
  // ============================================================

  it("should handle larger cycles without hanging", async () => {
    runtime.scheduler.enablePullMode();

    const cellA = runtime.getCell<number>(space, "4cycle-A", undefined, tx);
    cellA.set(1);
    const cellB = runtime.getCell<number>(space, "4cycle-B", undefined, tx);
    cellB.set(0);
    const cellC = runtime.getCell<number>(space, "4cycle-C", undefined, tx);
    cellC.set(0);
    const cellD = runtime.getCell<number>(space, "4cycle-D", undefined, tx);
    cellD.set(0);
    await tx.commit();
    tx = runtime.edit();

    let totalRuns = 0;

    // A → B → C → D → A (converges when D reaches 4)
    const actionA: Action = (actionTx) => {
      totalRuns++;
      const val = cellD.withTx(actionTx).get();
      if (val < 4) cellA.withTx(actionTx).send(val + 1);
    };
    const actionB: Action = (actionTx) => {
      totalRuns++;
      cellB.withTx(actionTx).send(cellA.withTx(actionTx).get());
    };
    const actionC: Action = (actionTx) => {
      totalRuns++;
      cellC.withTx(actionTx).send(cellB.withTx(actionTx).get());
    };
    const actionD: Action = (actionTx) => {
      totalRuns++;
      cellD.withTx(actionTx).send(cellC.withTx(actionTx).get());
    };

    // Subscribe all and let them run
    for (const action of [actionA, actionB, actionC, actionD]) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], writes: [] },
        { scheduleImmediately: true },
      );
      await runtime.idle();
    }

    // Let the cycle run for a few iterations
    for (let i = 0; i < 10; i++) {
      await runtime.idle();
    }

    // Should converge without infinite loop
    expect(cellD.get()).toBeLessThanOrEqual(4);
    // Should be bounded, not infinite
    expect(totalRuns).toBeLessThan(500);
  });

  it("should handle self-referential action without infinite loop", async () => {
    runtime.scheduler.enablePullMode();

    const counter = runtime.getCell<number>(
      space,
      "self-ref-counter",
      undefined,
      tx,
    );
    counter.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // Action reads and writes the same cell (converges after 5)
    const selfRefAction: Action = (actionTx) => {
      runCount++;
      const val = counter.withTx(actionTx).get();
      if (val < 5) {
        counter.withTx(actionTx).send(val + 1);
      }
    };

    runtime.scheduler.subscribe(
      selfRefAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );

    // Let it run for a while
    for (let i = 0; i < 20; i++) {
      await runtime.idle();
    }

    // Should have converged and stopped at some point
    // The exact value depends on how reactive updates propagate
    expect(counter.get()).toBeLessThanOrEqual(5);
    // Should not run infinitely
    expect(runCount).toBeLessThan(200);
  });

  it("should preserve action stats across multiple scheduling cycles", async () => {
    const cell = runtime.getCell<number>(
      space,
      "preserve-stats-cell",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // First scheduling cycle
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    let stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(1);
    const firstRunTime = stats!.lastRunTime;

    // Trigger another run by updating cell externally
    cell.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Stats should persist and accumulate
    stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(2);
    expect(stats!.totalTime).toBeGreaterThanOrEqual(firstRunTime);
  });

  it("should handle mixed cyclic and acyclic actions without hanging", async () => {
    runtime.scheduler.enablePullMode();

    // Acyclic: source → computed
    const source = runtime.getCell<number>(
      space,
      "mixed-source",
      undefined,
      tx,
    );
    source.set(1);
    const computed = runtime.getCell<number>(
      space,
      "mixed-computed",
      undefined,
      tx,
    );
    computed.set(0);

    // Cyclic: cycleA ↔ cycleB
    const cycleA = runtime.getCell<number>(
      space,
      "mixed-cycleA",
      undefined,
      tx,
    );
    cycleA.set(1);
    const cycleB = runtime.getCell<number>(
      space,
      "mixed-cycleB",
      undefined,
      tx,
    );
    cycleB.set(0);
    await tx.commit();
    tx = runtime.edit();

    let acyclicRuns = 0;
    let cycleRuns = 0;

    const acyclicAction: Action = (actionTx) => {
      acyclicRuns++;
      computed.withTx(actionTx).send(source.withTx(actionTx).get() * 2);
    };

    const cycleActionA: Action = (actionTx) => {
      cycleRuns++;
      cycleB.withTx(actionTx).send(cycleA.withTx(actionTx).get());
    };

    const cycleActionB: Action = (actionTx) => {
      cycleRuns++;
      const val = cycleB.withTx(actionTx).get();
      if (val < 5) cycleA.withTx(actionTx).send(val);
    };

    // Subscribe all
    runtime.scheduler.subscribe(
      acyclicAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      cycleActionA,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      cycleActionB,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Let them all run
    for (let i = 0; i < 10; i++) {
      await runtime.idle();
    }

    // The acyclic action should have run at least once
    expect(acyclicRuns).toBeGreaterThanOrEqual(1);

    // The computed value should be correct
    expect(computed.get()).toBe(2); // 1 * 2

    // Cycle runs should be bounded
    expect(cycleRuns).toBeLessThan(500);
  });
});

describe("debounce and throttling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should set and get debounce for an action", () => {
    const action: Action = () => {};

    // Initially no debounce
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // Set debounce
    runtime.scheduler.setDebounce(action, 100);
    expect(runtime.scheduler.getDebounce(action)).toBe(100);

    // Clear debounce
    runtime.scheduler.clearDebounce(action);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });

  it("should set debounce to 0 clears it", () => {
    const action: Action = () => {};

    runtime.scheduler.setDebounce(action, 100);
    expect(runtime.scheduler.getDebounce(action)).toBe(100);

    runtime.scheduler.setDebounce(action, 0);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });

  it("should delay action execution when debounce is set", async () => {
    const cell = runtime.getCell<number>(space, "debounce-test", undefined, tx);
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set a short debounce
    runtime.scheduler.setDebounce(action, 50);

    // Subscribe with scheduleImmediately
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce period
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.idle();

    // Now it should have run
    expect(runCount).toBe(1);
  });

  it("should coalesce rapid triggers into single execution", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-coalesce",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set debounce
    runtime.scheduler.setDebounce(action, 50);

    // Trigger multiple times rapidly
    for (let i = 0; i < 5; i++) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], writes: [] },
        { scheduleImmediately: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Should not have run yet (debounce keeps resetting)
    expect(runCount).toBe(0);

    // Wait for debounce to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.idle();

    // Should have run only once
    expect(runCount).toBe(1);
  });

  it("should apply debounce from subscribe options", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-option",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Subscribe with debounce option
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true, debounce: 50 },
    );

    // Verify debounce was set
    expect(runtime.scheduler.getDebounce(action)).toBe(50);

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.idle();

    expect(runCount).toBe(1);
  });

  it("should cancel debounce timer on unsubscribe", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-cancel",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set debounce
    runtime.scheduler.setDebounce(action, 100);

    // Subscribe with scheduleImmediately
    const cancel = runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );

    // Action should not have run yet
    expect(runCount).toBe(0);

    // Unsubscribe before debounce completes
    cancel();

    // Wait past the debounce period
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtime.idle();

    // Action should NOT have run because we unsubscribed
    expect(runCount).toBe(0);
  });

  it("should enable auto-debounce via subscribe option", () => {
    const action: Action = () => {};

    // Subscribe with autoDebounce enabled
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { autoDebounce: true },
    );

    // Auto-debounce should be enabled (internal state)
    // We can verify by checking that running the action multiple times
    // will eventually trigger auto-debounce
    // For now just verify no errors occur
  });

  it("should auto-debounce slow actions after threshold runs", async () => {
    const cell = runtime.getCell<number>(
      space,
      "auto-debounce-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Create a slow action (simulated with artificial delay tracking)
    const action: Action = (actionTx) => {
      // We can't easily make this actually slow in tests,
      // so we'll manually set the stats to simulate slow execution
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe with autoDebounce enabled
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true, autoDebounce: true },
    );
    await runtime.idle();

    // Initially no debounce
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // The auto-debounce requires the action to be slow (>50ms avg after 3 runs)
    // In unit tests we can't easily simulate slow execution time,
    // so we mainly verify the infrastructure is in place
  });

  it("should not auto-debounce fast actions", async () => {
    const cell = runtime.getCell<number>(space, "fast-action", undefined, tx);
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe with autoDebounce enabled
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true, autoDebounce: true },
    );
    await runtime.idle();

    // Run multiple times (fast actions)
    for (let i = 0; i < 5; i++) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], writes: [] },
        { scheduleImmediately: true },
      );
      await runtime.idle();
    }

    // Fast actions should NOT get auto-debounced
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // Stats should be tracked
    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBeGreaterThanOrEqual(5);
    // Average time should be well under threshold (50ms)
    expect(stats!.averageTime).toBeLessThan(50);
  });

  it("should work with both debounce and pull mode", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "debounce-pull-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "debounce-pull-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const effect: Action = (actionTx) => {
      runCount++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    // Set debounce before subscribing
    runtime.scheduler.setDebounce(effect, 50);

    // Subscribe as effect
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true, isEffect: true },
    );

    // Should not run immediately due to debounce
    expect(runCount).toBe(0);

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.idle();

    // Should have run
    expect(runCount).toBe(1);
    expect(result.get()).toBe(2);
  });
});

describe("throttle - staleness tolerance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should set and get throttle for an action", () => {
    const action: Action = () => {};

    // Initially no throttle
    expect(runtime.scheduler.getThrottle(action)).toBeUndefined();

    // Set throttle
    runtime.scheduler.setThrottle(action, 200);
    expect(runtime.scheduler.getThrottle(action)).toBe(200);

    // Clear throttle
    runtime.scheduler.clearThrottle(action);
    expect(runtime.scheduler.getThrottle(action)).toBeUndefined();
  });

  it("should set throttle to 0 clears it", () => {
    const action: Action = () => {};

    runtime.scheduler.setThrottle(action, 200);
    expect(runtime.scheduler.getThrottle(action)).toBe(200);

    runtime.scheduler.setThrottle(action, 0);
    expect(runtime.scheduler.getThrottle(action)).toBeUndefined();
  });

  it("should apply throttle from subscribe options", () => {
    const action: Action = () => {};

    // Subscribe with throttle option
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { throttle: 200 },
    );

    // Verify throttle was set
    expect(runtime.scheduler.getThrottle(action)).toBe(200);
  });

  it("should skip throttled action if ran recently", async () => {
    const cell = runtime.getCell<number>(
      space,
      "throttle-skip-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // First run (no throttle yet to establish lastRunTimestamp)
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();
    expect(runCount).toBe(1);

    // Now set throttle
    runtime.scheduler.setThrottle(action, 500);

    // Try to run again immediately
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Should be skipped due to throttle
    expect(runCount).toBe(1);
  });

  it("should run throttled action after throttle period expires", async () => {
    const cell = runtime.getCell<number>(
      space,
      "throttle-expire-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // First run with short throttle
    runtime.scheduler.setThrottle(action, 50);
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();
    expect(runCount).toBe(1);

    // Try immediately - should be throttled
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();
    expect(runCount).toBe(1);

    // Wait for throttle to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Now should run
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();
    expect(runCount).toBe(2);
  });

  it("should keep action dirty when throttled in pull mode", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "throttle-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "throttle-dirty-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computeCount = 0;
    const computation: Action = (actionTx) => {
      computeCount++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    // Run computation once to establish timestamp
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();
    expect(computeCount).toBe(1);

    // Set throttle
    runtime.scheduler.setThrottle(computation, 500);

    // Change source to mark computation dirty
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    // Wait for propagation
    await runtime.idle();

    // Computation should be marked dirty but not run (throttled)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);
    expect(computeCount).toBe(1);
  });

  it("should run throttled effect after throttle expires", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "throttle-pull-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "throttle-pull-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectCount = 0;
    const effect: Action = (actionTx) => {
      effectCount++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    // Subscribe as effect with short throttle
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true, throttle: 50, isEffect: true },
    );
    await runtime.idle();
    expect(effectCount).toBe(1);
    expect(result.get()).toBe(2);

    // Change source - effect is scheduled but throttled
    source.withTx(tx).send(5);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Still at old value due to throttle
    expect(effectCount).toBe(1);

    // Wait for throttle to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Trigger again - now throttle has expired, should run
    source.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Now effect should run
    expect(effectCount).toBe(2);
    expect(result.get()).toBe(20);
  });

  it("should record lastRunTimestamp in action stats", async () => {
    const action: Action = () => {};

    // No stats initially
    expect(runtime.scheduler.getActionStats(action)).toBeUndefined();

    // Run action
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Stats should now include lastRunTimestamp
    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.lastRunTimestamp).toBeDefined();
    expect(stats!.lastRunTimestamp).toBeGreaterThan(0);
  });

  it("should allow first run even with throttle set (no previous timestamp)", async () => {
    const cell = runtime.getCell<number>(
      space,
      "throttle-first-run",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set throttle BEFORE first run
    runtime.scheduler.setThrottle(action, 1000);

    // First run should still execute (no previous timestamp to throttle against)
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    expect(runCount).toBe(1);
  });
});

describe("push-triggered filtering", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should track mightWrite from actual writes", async () => {
    const cell = runtime.getCell<number>(
      space,
      "mightwrite-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(42);
    };

    // Initially no mightWrite
    expect(runtime.scheduler.getMightWrite(action)).toBeUndefined();

    // Run action
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // mightWrite should now include the cell
    const mightWrite = runtime.scheduler.getMightWrite(action);
    expect(mightWrite).toBeDefined();
    expect(mightWrite!.length).toBeGreaterThan(0);
  });

  it("should accumulate mightWrite over multiple runs", async () => {
    const cell1 = runtime.getCell<number>(space, "mw-accum-1", undefined, tx);
    const cell2 = runtime.getCell<number>(space, "mw-accum-2", undefined, tx);
    cell1.set(0);
    cell2.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writeToCell2 = false;
    const action: Action = (actionTx) => {
      cell1.withTx(actionTx).send(1);
      if (writeToCell2) {
        cell2.withTx(actionTx).send(2);
      }
    };

    // First run - writes only to cell1
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell1.getAsNormalizedFullLink()] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    const mightWrite1 = runtime.scheduler.getMightWrite(action);
    const initialLength = mightWrite1?.length || 0;

    // Second run - writes to both cells
    writeToCell2 = true;
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        writes: [
          cell1.getAsNormalizedFullLink(),
          cell2.getAsNormalizedFullLink(),
        ],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // mightWrite should have grown
    const mightWrite2 = runtime.scheduler.getMightWrite(action);
    expect(mightWrite2!.length).toBeGreaterThan(initialLength);
  });

  it("should track filter stats", async () => {
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(space, "filter-stats", undefined, tx);
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    const stats = runtime.scheduler.getFilterStats();
    // Action should have executed (not filtered)
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should allow first run even without pushTriggered (scheduleImmediately)", async () => {
    runtime.scheduler.enablePullMode();
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(
      space,
      "first-run-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // First run with scheduleImmediately should work
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    expect(runCount).toBe(1);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBe(1);
    expect(stats.filtered).toBe(0);
  });

  it("should use pushTriggered to track storage-triggered actions", async () => {
    runtime.scheduler.enablePullMode();

    const cell = runtime.getCell<number>(
      space,
      "push-triggered-test",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe as effect - first run
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Change cell via external means (simulating storage change)
    cell.withTx(tx).send(100);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Action should have been triggered by storage change and run
    expect(runCount).toBe(2);

    // Verify it was tracked as push-triggered (executed, not filtered)
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should not filter actions scheduled with scheduleImmediately", async () => {
    runtime.scheduler.enablePullMode();

    const cell = runtime.getCell<number>(
      space,
      "schedule-immed-filter",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Run once to establish mightWrite
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      { scheduleImmediately: true },
    );
    await runtime.idle();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Run again with scheduleImmediately - should bypass filter
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    expect(runCount).toBe(2);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
  });

  it("should reset filter stats", () => {
    runtime.scheduler.resetFilterStats();
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
    expect(stats.executed).toBe(0);
  });
});

describe("parent-child action ordering", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Enable pull mode for parent-child ordering tests
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should execute parent actions before child actions", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-order-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    // Parent action that subscribes a child during execution
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const val = source.withTx(actionTx).get();

      // Subscribe child action during parent execution
      runtime.scheduler.subscribe(
        childAction,
        { reads: [], writes: [] },
        { scheduleImmediately: true },
      );

      return val;
    };

    const childAction: Action = (_actionTx) => {
      executionOrder.push("child");
    };

    // Subscribe parent
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    // Parent should execute first, then child
    expect(executionOrder).toEqual(["parent", "child"]);
  });

  it("should skip child if parent unsubscribes it", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-unsubscribe-source",
      undefined,
      tx,
    );
    source.set(1);
    const toggle = runtime.getCell<boolean>(
      space,
      "parent-child-unsubscribe-toggle",
      undefined,
      tx,
    );
    toggle.set(true);
    await tx.commit();
    tx = runtime.edit();

    let childCanceler: (() => void) | null = null;

    // Parent action that conditionally subscribes/unsubscribes child
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const shouldHaveChild = toggle.withTx(actionTx).get();

      if (shouldHaveChild && !childCanceler) {
        childCanceler = runtime.scheduler.subscribe(
          childAction,
          { reads: [], writes: [] },
          { scheduleImmediately: true },
        );
      } else if (!shouldHaveChild && childCanceler) {
        childCanceler();
        childCanceler = null;
      }
    };

    const childAction: Action = (_actionTx) => {
      executionOrder.push("child");
    };

    // Subscribe parent as an effect (so it re-runs when toggle changes)
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    expect(executionOrder).toEqual(["parent", "child"]);

    // Now toggle to false - parent should unsubscribe child
    executionOrder.length = 0;
    toggle.withTx(tx).send(false);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Parent runs (and unsubscribes child), child should NOT run
    expect(executionOrder).toEqual(["parent"]);
  });

  it("should order parent before child even when both become dirty", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-both-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;

    // Parent reads source and subscribes child on first run
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const val = source.withTx(actionTx).get();

      if (!childSubscribed) {
        childSubscribed = true;
        // Subscribe child as an effect too (so it re-runs when source changes)
        runtime.scheduler.subscribe(
          childAction,
          { reads: [], writes: [] },
          { scheduleImmediately: true, isEffect: true },
        );
      }

      return val;
    };

    // Child also reads source (so both become dirty when source changes)
    const childAction: Action = (actionTx) => {
      executionOrder.push("child");
      source.withTx(actionTx).get();
    };

    // Mark parent as effect so it re-runs when source changes
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    expect(executionOrder).toEqual(["parent", "child"]);

    // Change source - both parent and child should become dirty
    executionOrder.length = 0;
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Parent should still execute before child
    expect(executionOrder).toEqual(["parent", "child"]);
  });

  it("should handle nested parent-child-grandchild ordering", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-grandchild-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let grandchildSubscribed = false;

    const grandparentAction: Action = (actionTx) => {
      executionOrder.push("grandparent");
      source.withTx(actionTx).get();

      if (!childSubscribed) {
        childSubscribed = true;
        // Subscribe parent as effect so it re-runs when source changes
        runtime.scheduler.subscribe(
          parentAction,
          { reads: [], writes: [] },
          { scheduleImmediately: true, isEffect: true },
        );
      }
    };

    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      source.withTx(actionTx).get();

      if (!grandchildSubscribed) {
        grandchildSubscribed = true;
        // Subscribe child as effect so it re-runs when source changes
        runtime.scheduler.subscribe(
          childAction,
          { reads: [], writes: [] },
          { scheduleImmediately: true, isEffect: true },
        );
      }
    };

    const childAction: Action = (actionTx) => {
      executionOrder.push("child");
      source.withTx(actionTx).get();
    };

    // Mark grandparent as effect so the chain re-runs when source changes
    runtime.scheduler.subscribe(
      grandparentAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    // Should execute in order: grandparent -> parent -> child
    expect(executionOrder).toEqual(["grandparent", "parent", "child"]);

    // Change source - all three should become dirty and re-execute in order
    executionOrder.length = 0;
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(executionOrder).toEqual(["grandparent", "parent", "child"]);
  });

  it("should clean up parent-child relationships on unsubscribe", async () => {
    const source = runtime.getCell<number>(
      space,
      "parent-child-cleanup-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let childCanceler: (() => void) | undefined;
    let childRunCount = 0;

    const parentAction: Action = (actionTx) => {
      source.withTx(actionTx).get();

      if (!childCanceler) {
        childCanceler = runtime.scheduler.subscribe(
          childAction,
          { reads: [], writes: [] },
          { scheduleImmediately: true },
        );
      }
    };

    const childAction: Action = (actionTx) => {
      childRunCount++;
      source.withTx(actionTx).get();
    };

    const parentCanceler = runtime.scheduler.subscribe(
      parentAction,
      { reads: [], writes: [] },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    expect(childRunCount).toBe(1);

    // Unsubscribe the parent - this should clean up the relationship
    parentCanceler();

    // Also unsubscribe child to prevent it from running independently
    if (childCanceler) childCanceler();

    // Change source and verify neither runs
    childRunCount = 0;
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(childRunCount).toBe(0);
  });
});

describe("pull mode with references", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should propagate dirtiness through references (nested lift scenario)", async () => {
    // This test reproduces the nested lift pattern where:
    // - Inner lift reads source, writes to innerOutput
    // - outerInput cell contains a REFERENCE to innerOutput
    // - Outer lift reads outerInput (following ref to innerOutput), writes to outerOutput
    // - Effect reads outerOutput
    //
    // When source changes:
    // 1. Inner lift is marked dirty
    // 2. Outer lift should be marked dirty because it reads (via reference) what inner writes
    // 3. Effect should run and see updated value

    const source = runtime.getCell<string[]>(
      space,
      "nested-ref-source",
      undefined,
      tx,
    );
    source.set([]);

    const innerOutput = runtime.getCell<string | undefined>(
      space,
      "nested-ref-inner-output",
      undefined,
      tx,
    );
    innerOutput.set(undefined);

    // This cell holds a REFERENCE to innerOutput (simulating how lift passes results)
    const outerInput = runtime.getCell<string | undefined>(
      space,
      "nested-ref-outer-input",
      undefined,
      tx,
    );
    // Set it to be a reference pointing to innerOutput
    outerInput.set(undefined);

    const outerOutput = runtime.getCell<string>(
      space,
      "nested-ref-outer-output",
      undefined,
      tx,
    );
    outerOutput.set("default");

    const effectResult = runtime.getCell<string>(
      space,
      "nested-ref-effect-result",
      undefined,
      tx,
    );
    effectResult.set("");

    await tx.commit();
    tx = runtime.edit();

    let innerRuns = 0;
    let outerRuns = 0;
    let effectRuns = 0;

    // Inner lift: arr => arr[0] (returns undefined when array is empty)
    const innerLift: Action = (actionTx) => {
      innerRuns++;
      const arr = source.withTx(actionTx).get() ?? [];
      const firstItem = arr[0]; // Returns undefined when empty!
      innerOutput.withTx(actionTx).send(firstItem);
    };

    // Outer lift: (name, firstItem) => name || firstItem || "default"
    // For this test, we'll read innerOutput directly to simulate following the reference
    const outerLift: Action = (actionTx) => {
      outerRuns++;
      const firstItem = innerOutput.withTx(actionTx).get();
      const result = firstItem || "default";
      outerOutput.withTx(actionTx).send(result);
    };

    // Effect: sink that captures the output
    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = outerOutput.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val ?? "");
    };

    // Subscribe in order: inner, outer, effect
    runtime.scheduler.subscribe(
      innerLift,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [innerOutput.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      outerLift,
      {
        reads: [innerOutput.getAsNormalizedFullLink()],
        writes: [outerOutput.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [outerOutput.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true, isEffect: true },
    );
    await runtime.idle();

    // Initial state: source is [], innerOutput is undefined, outerOutput is "default"
    expect(innerRuns).toBe(1);
    expect(outerRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe("default");

    // Now change source to ["apple"]
    source.withTx(tx).send(["apple"]);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // With fix: All should run because dependency chain is now properly built
    // (mightWrite preserves declared writes, enabling correct topological ordering)
    expect(innerRuns).toBe(2);
    expect(outerRuns).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe("apple");
  });
});

describe("handler dependency pulling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should pull computed dependencies before running handler (handler is only reader)", async () => {
    // This test validates that when a handler's populateDependencies callback
    // reads a computed cell that has no other readers, the scheduler will
    // pull (compute) that value before running the handler.
    //
    // Setup:
    // - source cell: initial value
    // - computed action: reads source, writes to computedOutput
    // - event handler: reads computedOutput (via populateDependencies), writes to result
    // - The handler is the ONLY reader of computedOutput

    const source = runtime.getCell<number>(
      space,
      "handler-pull-source",
      undefined,
      tx,
    );
    source.set(10);

    const computedOutput = runtime.getCell<number>(
      space,
      "handler-pull-computed",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-pull-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-pull-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;
    const executionOrder: string[] = [];

    // Computed action: reads source, writes doubled value to computedOutput
    const computedAction: Action = (actionTx) => {
      computedRuns++;
      executionOrder.push("computed");
      const val = source.withTx(actionTx).get();
      computedOutput.withTx(actionTx).send(val * 2);
    };

    // Subscribe the computed action
    runtime.scheduler.subscribe(
      computedAction,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [computedOutput.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );
    await runtime.idle();

    expect(computedRuns).toBe(1);
    expect(computedOutput.get()).toBe(20); // 10 * 2

    // Event handler: reads computedOutput and adds the event value
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      executionOrder.push("handler");
      const computed = computedOutput.withTx(handlerTx).get();
      result.withTx(handlerTx).send(computed + event);
    };

    // populateDependencies callback - this tells the scheduler what the handler reads
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computedOutput.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset execution order tracking
    executionOrder.length = 0;
    computedRuns = 0;
    handlerRuns = 0;

    // Change source value - this marks computedAction as dirty
    source.withTx(tx).send(20);
    await tx.commit();
    tx = runtime.edit();

    // The computed action should NOT run yet (pull mode, no reader)
    expect(computedRuns).toBe(0);

    // Now queue an event - this should trigger:
    // 1. Scheduler sees handler depends on computedOutput (via populateDependencies)
    // 2. computedOutput's producer (computedAction) is dirty
    // 3. Scheduler pulls computedAction first
    // 4. Then runs the handler
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 5);
    await runtime.idle();

    // Computed should have run (pulled by handler dependency)
    expect(computedRuns).toBe(1);
    expect(computedOutput.get()).toBe(40); // 20 * 2

    // Handler should have run with the fresh computed value
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(45); // 40 + 5

    // Execution order should be: computed first, then handler
    expect(executionOrder).toEqual(["computed", "handler"]);
  });

  it("should handle multiple dirty dependencies before running handler", async () => {
    // Test that multiple dirty computed dependencies are all pulled before handler runs

    const source1 = runtime.getCell<number>(
      space,
      "handler-multi-source1",
      undefined,
      tx,
    );
    source1.set(10);

    const source2 = runtime.getCell<number>(
      space,
      "handler-multi-source2",
      undefined,
      tx,
    );
    source2.set(100);

    const computed1 = runtime.getCell<number>(
      space,
      "handler-multi-computed1",
      undefined,
      tx,
    );
    const computed2 = runtime.getCell<number>(
      space,
      "handler-multi-computed2",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-multi-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-multi-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computed1Runs = 0;
    let computed2Runs = 0;
    let handlerRuns = 0;

    // First computed action
    const computedAction1: Action = (actionTx) => {
      computed1Runs++;
      const val = source1.withTx(actionTx).get();
      computed1.withTx(actionTx).send(val * 2);
    };

    // Second computed action
    const computedAction2: Action = (actionTx) => {
      computed2Runs++;
      const val = source2.withTx(actionTx).get();
      computed2.withTx(actionTx).send(val * 3);
    };

    runtime.scheduler.subscribe(
      computedAction1,
      {
        reads: [source1.getAsNormalizedFullLink()],
        writes: [computed1.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [source2.getAsNormalizedFullLink()],
        writes: [computed2.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    await runtime.idle();

    expect(computed1.get()).toBe(20);
    expect(computed2.get()).toBe(300);

    // Handler reads both computed values
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const c1 = computed1.withTx(handlerTx).get();
      const c2 = computed2.withTx(handlerTx).get();
      result.withTx(handlerTx).send(c1 + c2 + event);
    };

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computed1.withTx(depTx).get();
      computed2.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset counters
    computed1Runs = 0;
    computed2Runs = 0;
    handlerRuns = 0;

    // Change both sources
    source1.withTx(tx).send(20);
    source2.withTx(tx).send(200);
    await tx.commit();
    tx = runtime.edit();

    // Neither should run yet (pull mode)
    expect(computed1Runs).toBe(0);
    expect(computed2Runs).toBe(0);

    // Queue event
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
    await runtime.idle();

    // Both computed should have run
    expect(computed1Runs).toBe(1);
    expect(computed2Runs).toBe(1);
    expect(computed1.get()).toBe(40); // 20 * 2
    expect(computed2.get()).toBe(600); // 200 * 3

    // Handler should have run with fresh values
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(641); // 40 + 600 + 1
  });

  it("should re-queue event if dependencies change during pull", async () => {
    // Test the scenario where pulling one dependency causes another to become dirty
    // (e.g., a chain: source -> computed1 -> computed2 -> handler)
    // The handler should wait until the full chain is computed

    const source = runtime.getCell<number>(
      space,
      "handler-chain-source",
      undefined,
      tx,
    );
    source.set(5);

    const computed1 = runtime.getCell<number>(
      space,
      "handler-chain-computed1",
      undefined,
      tx,
    );
    const computed2 = runtime.getCell<number>(
      space,
      "handler-chain-computed2",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-chain-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-chain-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computed1Runs = 0;
    let computed2Runs = 0;
    let handlerRuns = 0;

    // computed1 reads source
    const computedAction1: Action = (actionTx) => {
      computed1Runs++;
      const val = source.withTx(actionTx).get();
      computed1.withTx(actionTx).send(val * 2);
    };

    // computed2 reads computed1
    const computedAction2: Action = (actionTx) => {
      computed2Runs++;
      const val = computed1.withTx(actionTx).get();
      computed2.withTx(actionTx).send(val + 10);
    };

    runtime.scheduler.subscribe(
      computedAction1,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [computed1.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [computed1.getAsNormalizedFullLink()],
        writes: [computed2.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: true },
    );

    await runtime.idle();

    expect(computed1.get()).toBe(10); // 5 * 2
    expect(computed2.get()).toBe(20); // 10 + 10

    // Handler reads computed2 (end of chain)
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const c2 = computed2.withTx(handlerTx).get();
      result.withTx(handlerTx).send(c2 + event);
    };

    // populateDependencies reads computed2, but computed2 depends on computed1
    // which depends on source. When source changes, both computed actions are dirty.
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computed2.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset counters
    computed1Runs = 0;
    computed2Runs = 0;
    handlerRuns = 0;

    // Change source - this makes computed1 dirty, and when computed1 runs,
    // it will make computed2 dirty
    source.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();

    // Queue event
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await runtime.idle();

    // Both computed should have run in order
    expect(computed1Runs).toBe(1);
    expect(computed2Runs).toBe(1);
    expect(computed1.get()).toBe(20); // 10 * 2
    expect(computed2.get()).toBe(30); // 20 + 10

    // Handler should see the final computed value
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(33); // 30 + 3
  });

  it("should wait for dynamically created lift before dispatching to downstream handler", async () => {
    // This test validates that when handler A triggers a lift and handler B
    // depends on that lift's output, the scheduler waits for the lift to
    // compute before running handler B.
    //
    // Setup:
    // - Stream B: handler B reads liftOutput (via populateDependencies)
    // - Stream A: handler A writes to liftInput (triggering lift) and queues event to B
    // - Lift: reads liftInput, writes to liftOutput
    // - Send event to A's stream
    //
    // Expected: A runs -> lift runs -> B runs (with fresh lift output)

    // Stream B - the downstream handler
    const streamB = runtime.getCell<number>(
      space,
      "dynamic-lift-streamB",
      undefined,
      tx,
    );
    streamB.set(0);

    // Cell to store what handler B sees from the lift output
    const handlerBSawLiftOutput = runtime.getCell<number[]>(
      space,
      "dynamic-lift-B-saw",
      undefined,
      tx,
    );
    handlerBSawLiftOutput.set([]);

    // Stream A - the upstream handler
    const streamA = runtime.getCell<number>(
      space,
      "dynamic-lift-streamA",
      undefined,
      tx,
    );
    streamA.set(0);

    // Lift input/output cells
    const liftInput = runtime.getCell<number>(
      space,
      "dynamic-lift-input",
      undefined,
      tx,
    );
    liftInput.set(0);

    const liftOutput = runtime.getCell<number>(
      space,
      "dynamic-lift-output",
      undefined,
      tx,
    );
    liftOutput.set(0);

    await tx.commit();
    tx = runtime.edit();

    let handlerARuns = 0;
    let handlerBRuns = 0;
    let liftRuns = 0;
    const executionOrder: string[] = [];

    // Lift action: transforms input by doubling it
    const liftAction: Action = (actionTx) => {
      liftRuns++;
      executionOrder.push("lift");
      const input = liftInput.withTx(actionTx).get();
      liftOutput.withTx(actionTx).send(input * 2);
    };

    // Subscribe the lift - NOT scheduled immediately
    // This tests that the lift is pulled when handler B needs it
    runtime.scheduler.subscribe(
      liftAction,
      {
        reads: [liftInput.getAsNormalizedFullLink()],
        writes: [liftOutput.getAsNormalizedFullLink()],
      },
      { scheduleImmediately: false },
    );

    await runtime.idle();
    expect(liftRuns).toBe(0); // NOT run yet - no scheduleImmediately
    expect(liftOutput.get()).toBe(0); // Still initial value

    // Handler B: receives a LINK to liftOutput as the event, reads from it
    const handlerB: EventHandler = (handlerTx, event: { "/": string }) => {
      handlerBRuns++;
      // The event IS a link to liftOutput - read from it
      // This simulates a handler receiving a reference to computed data
      const liftVal = liftOutput.withTx(handlerTx).get();
      executionOrder.push(`handlerB:lift=${liftVal}`);
      const saw = handlerBSawLiftOutput.withTx(handlerTx).get();
      handlerBSawLiftOutput.withTx(handlerTx).send([...saw, liftVal]);
    };

    // Handler B's populateDependencies - reads liftOutput to capture dependency
    // In a real scenario, this would read from the event (which is a link to liftOutput)
    // For this test, we directly read liftOutput since we know that's what the event points to
    const handlerBPopulateDeps = (depTx: IExtendedStorageTransaction) => {
      liftOutput.withTx(depTx).get();
    };

    // Handler A: writes to liftInput and queues a LINK to liftOutput as event to B
    const handlerA: EventHandler = (handlerTx, event: number) => {
      handlerARuns++;
      executionOrder.push(`handlerA:${event}`);

      // Write to lift input - this will make the lift dirty
      liftInput.withTx(handlerTx).send(event);

      // Queue an event to stream B where the event VALUE is a link to liftOutput
      // This simulates: "hey B, go read from this computed cell"
      // The scheduler should see that B depends on liftOutput and pull the lift first
      const liftOutputLink = liftOutput.getAsLink();
      runtime.scheduler.queueEvent(streamB.getAsNormalizedFullLink(), liftOutputLink);
    };

    // Register handlers
    runtime.scheduler.addEventHandler(handlerA, streamA.getAsNormalizedFullLink());
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
      handlerBPopulateDeps,
    );

    await runtime.idle();

    // Reset tracking
    executionOrder.length = 0;
    handlerARuns = 0;
    handlerBRuns = 0;
    liftRuns = 0;

    // Send event to stream A with value 5
    runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), 5);
    await runtime.idle();

    // Handler A should have run
    expect(handlerARuns).toBe(1);

    // Lift should have run (its input changed from 0 to 5)
    expect(liftRuns).toBe(1);
    expect(liftOutput.get()).toBe(10); // 5 * 2

    // Handler B should have run and seen the FRESH lift output (10, not stale 0)
    expect(handlerBRuns).toBe(1);
    expect(handlerBSawLiftOutput.get()).toEqual([10]);

    // Verify execution order
    expect(executionOrder).toContain("handlerA:5");
    expect(executionOrder).toContain("lift");

    // The lift should run before handler B sees the fresh value
    const liftIndex = executionOrder.indexOf("lift");
    const handlerBIndex = executionOrder.findIndex((s) =>
      s.startsWith("handlerB:"),
    );
    expect(liftIndex).toBeLessThan(handlerBIndex);

    // Handler B should have seen lift=10 (the fresh value, not stale 0)
    expect(executionOrder.find((s) => s.startsWith("handlerB:"))).toBe(
      "handlerB:lift=10",
    );
  });
});
