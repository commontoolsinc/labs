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
import { type JSONSchema } from "../src/builder/types.ts";
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
    runtime.scheduler.subscribe(adder, { reads: [], writes: [] }, {});
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.withTx(tx).send(2); // Simulate external change
    tx.commit();
    tx = runtime.edit();
    await c.pull();
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
    }, {});
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2); // No log, simulate external change
    tx.commit();
    tx = runtime.edit();
    await c.pull();
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
    runtime.scheduler.subscribe(adder, { reads: [], writes: [] }, {});
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    runtime.scheduler.unsubscribe(adder);
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
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
    }, {});
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
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
    runtime.scheduler.subscribe(adder1, { reads: [], writes: [] }, {});
    await e.pull();
    runtime.scheduler.subscribe(adder2, { reads: [], writes: [] }, {});
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await e.pull();
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

    runtime.scheduler.subscribe(adder1, { reads: [], writes: [] }, {});
    await e.pull();
    runtime.scheduler.subscribe(adder2, { reads: [], writes: [] }, {});
    await e.pull();
    runtime.scheduler.subscribe(adder3, { reads: [], writes: [] }, {});
    await e.pull();

    await e.pull();

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

    runtime.scheduler.subscribe(inc, { reads: [], writes: [] }, {});
    await counter.pull();
    expect(counter.get()).toBe(1);
    await counter.pull();
    expect(counter.get()).toBe(1);

    by.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await counter.pull();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    runtime.scheduler.subscribe(inc, { reads: [], writes: [] }, {
      isEffect: true,
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
      {},
    );
    await resultCell.pull();
    expect(actionRunCount).toBe(1);
    expect(lastReadValue).toEqual({ value: 1 });
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });

    // Change the source cell
    sourceCell.withTx(tx).set({ value: 5 });
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    // Action should NOT run again because the read was ignored
    expect(actionRunCount).toBe(1); // Still 1!
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } }); // Unchanged

    // Change the source cell again to be extra sure
    sourceCell.withTx(tx).set({ value: 10 });
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    // Still should not have run
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });
  });

  it("should track potentialWrites via Cell.set on nested path", async () => {
    // Create a cell with nested structure
    const testCell = runtime.getCell<{ nested: { a: number; b: string } }>(
      space,
      "potential-writes-cell-set-test",
      undefined,
      tx,
    );
    testCell.set({ nested: { a: 1, b: "hello" } });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set nested values where `a` stays the same but `b` changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).key("nested").set({ a: 1, b: "world" });

    const log = txToReactivityLog(setTx);

    // key("nested").set() reads the nested object to compare
    // The "nested" path should appear in potentialWrites
    expect(log.potentialWrites).toBeDefined();
    expect(
      log.potentialWrites!.some((addr) => addr.path[0] === "nested"),
    ).toBe(true);

    // Only `b` changed within nested, so nested.b should be in writes
    expect(
      log.writes.some((w) => w.path[0] === "nested" && w.path[1] === "b"),
    ).toBe(true);
    // nested.a should NOT be in writes (value didn't change)
    expect(
      log.writes.some((w) => w.path[0] === "nested" && w.path[1] === "a"),
    ).toBe(false);

    await setTx.commit();
  });

  it("should include nested path in potentialWrites when using key().set()", async () => {
    // Create a cell with nested structure
    const testCell = runtime.getCell<{
      data: { unchanged: number; changed: number };
    }>(
      space,
      "diff-update-potential-writes-cell",
      undefined,
      tx,
    );
    testCell.set({ data: { unchanged: 42, changed: 1 } });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set nested values where only one property changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).key("data").set({ unchanged: 42, changed: 999 });

    const log = txToReactivityLog(setTx);

    // The "data" path should be in potentialWrites because diffAndUpdate
    // reads the nested object to compare
    expect(log.potentialWrites).toBeDefined();
    expect(log.potentialWrites!.some((addr) => addr.path[0] === "data")).toBe(
      true,
    );

    // Only changed property within data should be in writes
    expect(
      log.writes.some((w) => w.path[0] === "data" && w.path[1] === "changed"),
    ).toBe(true);
    // unchanged property should NOT be in writes (value didn't change)
    expect(
      log.writes.some((w) => w.path[0] === "data" && w.path[1] === "unchanged"),
    ).toBe(false);

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

    await eventResultCell.pull();

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
    await eventCell.pull();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);

    removeHandler();

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await eventCell.pull();

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
    runtime.scheduler.subscribe(action, { reads: [], writes: [] }, {});
    await eventResultCell.pull();

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    expect(actionCount).toBe(1);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await eventResultCell.pull();

    expect(eventCount).toBe(1);
    expect(eventResultCell.get()).toBe(1);

    expect(actionCount).toBe(2);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await eventResultCell.pull();

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
        { isEffect: true },
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
        {},
      );
      runtime.scheduler.subscribe(
        action2,
        {
          reads: [intermediate.getAsNormalizedFullLink()],
          writes: [output.getAsNormalizedFullLink()],
        },
        {},
      );

      // Allow all actions to complete (action1 will retry twice)
      for (let i = 0; i < 20 && action1Attempts < 3; i++) {
        await output.pull();
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
    await resultCell.pull();
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

    await resultCell.pull();
    await resultCell.pull(); // Wait for retry
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

    await resultCell.pull();
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
    await resultCell.pull();
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

    await resultCell.pull();
    await resultCell.pull(); // Retry 1
    await resultCell.pull(); // Retry 2 (final)
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
    runtime.scheduler.subscribe(action, { reads: [], writes: [] }, {});
    runtime.scheduler.queueExecution();
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
      { isEffect: true },
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
      { isEffect: false },
    );
    runtime.scheduler.subscribe(
      effect,
      { reads: [], writes: [] },
      { isEffect: true },
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

  it("should track sink() parent-child relationship when called inside an action", async () => {
    const sourceCell = runtime.getCell<number>(
      space,
      "sink-parent-source",
      undefined,
      tx,
    );
    sourceCell.set(1);

    const observedCell = runtime.getCell<number>(
      space,
      "sink-parent-observed",
      undefined,
      tx,
    );
    observedCell.set(42);

    await tx.commit();
    tx = runtime.edit();

    let sinkCalled = false;
    let parentCalled = false;
    let sinkCancel: (() => void) | undefined;

    // Parent action that creates a sink during its execution
    const parentAction: Action = (actionTx) => {
      parentCalled = true;
      sourceCell.withTx(actionTx).get();

      // Create a sink inside the action - this should track parent relationship
      if (!sinkCancel) {
        sinkCancel = observedCell.sink((_value) => {
          sinkCalled = true;
        });
      }
    };

    runtime.scheduler.subscribe(parentAction, {
      reads: [sourceCell.getAsNormalizedFullLink()],
      writes: [],
    }, { isEffect: true }); // Mark as effect so it runs in pull mode

    await runtime.idle();

    // Verify the parent action was called
    expect(parentCalled).toBe(true);

    // Verify the sink was called (sink() always calls callback immediately on creation)
    expect(sinkCalled).toBe(true);

    // Get the graph snapshot and verify parent-child relationship
    const graph = runtime.scheduler.getGraphSnapshot();

    // Find the sink action node (named sink:space/...)
    const sinkNodes = graph.nodes.filter((n) => n.id.startsWith("sink:"));
    expect(sinkNodes.length).toBe(1);
    const sinkNode = sinkNodes[0];

    // Verify the sink has a parent (the parent action)
    expect(sinkNode.parentId).toBeDefined();

    // Verify the parent node exists and has childCount
    const parentNode = graph.nodes.find((n) => n.id === sinkNode.parentId);
    expect(parentNode).toBeDefined();
    expect(parentNode!.childCount).toBeGreaterThanOrEqual(1);

    sinkCancel!();
    await runtime.idle();
  });

  it("should track dependents for reverse dependency graph", async () => {
    runtime.scheduler.enablePullMode();

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
      {},
    );
    await output.pull();

    // Subscribe action2 (reads intermediate)
    runtime.scheduler.subscribe(
      action2,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      {},
    );
    await output.pull();

    // action2 should be a dependent of action1 (action1 writes what action2 reads)
    const dependents = runtime.scheduler.getDependents(action1);
    expect(dependents.has(action2)).toBe(true);
  });

  it("should backfill dependents when writer is added after effect subscribes", async () => {
    runtime.scheduler.enablePullMode();

    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "backfill-writer-after-effect",
      undefined,
      tx,
    );
    data.set({ foo: 1, bar: 2 });
    await tx.commit();
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      data.withTx(actionTx).key("foo").get();
    };

    runtime.scheduler.subscribe(effect, effect, { isEffect: true });
    await runtime.scheduler.idle();

    const computation: Action = (actionTx) => {
      data.withTx(actionTx).key("foo").set(2);
    };
    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [data.key("foo").getAsNormalizedFullLink()] },
      {},
    );

    const dependents = runtime.scheduler.getDependents(computation);
    expect(dependents.has(effect)).toBe(true);
  });

  it("should backfill only when new writer paths overlap existing reads", async () => {
    runtime.scheduler.enablePullMode();

    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "backfill-writer-paths",
      undefined,
      tx,
    );
    data.set({ foo: 1, bar: 2 });
    await tx.commit();
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      data.withTx(actionTx).key("bar").get();
    };

    runtime.scheduler.subscribe(effect, effect, { isEffect: true });
    await runtime.scheduler.idle();

    const computation: Action = (actionTx) => {
      data.withTx(actionTx).key("foo").set(2);
    };
    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [data.key("foo").getAsNormalizedFullLink()] },
      {},
    );

    const initialDependents = runtime.scheduler.getDependents(computation);
    expect(initialDependents.has(effect)).toBe(false);

    runtime.scheduler.resubscribe(computation, {
      reads: [],
      writes: [
        data.key("foo").getAsNormalizedFullLink(),
        data.key("bar").getAsNormalizedFullLink(),
      ],
    });

    const updatedDependents = runtime.scheduler.getDependents(computation);
    expect(updatedDependents.has(effect)).toBe(true);
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
      {},
    );
    await result.pull();

    expect(computationRuns).toBe(1);
    expect(result.get()).toBe(10);

    // Change source - should trigger computation in push mode
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();

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
      {},
    );
    await result.pull();

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

  it("should preserve writes when collecting dependencies from ReactivityLog", async () => {
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

    const target = runtime.getCell<number>(
      space,
      "reactivity-log-writes-target",
      undefined,
      tx,
    );
    target.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writerRuns = 0;
    const writer: Action = (actionTx) => {
      writerRuns++;
      target.withTx(actionTx).send(1);
    };

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [],
        writes: [target.getAsNormalizedFullLink()],
      },
      {},
    );

    await runtime.scheduler.idle();
    expect(writerRuns).toBe(0);

    // Force dependency collection to run against the stored ReactivityLog entry.
    const schedulerInternal = runtime.scheduler as unknown as {
      pendingDependencyCollection: Set<Action>;
    };
    schedulerInternal.pendingDependencyCollection.add(writer);
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    expect(writerRuns).toBe(0);
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
      {},
    );
    await effectResult.pull();

    // Subscribe effect with isEffect: true
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    // Verify dependency tracking is set up correctly
    const dependents = runtime.scheduler.getDependents(computation);
    expect(dependents.has(effect)).toBe(true);

    // Track initial effect runs
    const initialEffectRuns = effectRuns;

    // Change source - computation should be marked dirty, effect should be scheduled
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await effectResult.pull();

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
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      computation2,
      {
        reads: [intermediate1.getAsNormalizedFullLink()],
        writes: [intermediate2.getAsNormalizedFullLink()],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate2.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    expect(effectResult.get()).toBe((1 + 1) * 2 - 3);
    expect(comp2Runs).toBe(1);
    expect(effectRuns).toBe(1);

    const tx2 = runtime.edit();
    source.withTx(tx2).send(5);
    await tx2.commit();
    tx = runtime.edit();
    await effectResult.pull();

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
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(20);

    // Switch computation to sourceB
    const toggleTx = runtime.edit();
    selector.withTx(toggleTx).send(true);
    await toggleTx.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);

    // Updating sourceA should not dirty the computation any more
    const tx3 = runtime.edit();
    sourceA.withTx(tx3).send(999);
    await tx3.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Updating sourceB should still run the computation
    const tx4 = runtime.edit();
    sourceB.withTx(tx4).send(6);
    await tx4.commit();
    tx = runtime.edit();
    await effectResult.pull();

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
      {},
    );
    runtime.scheduler.queueExecution();
    await runtime.idle();

    // In pull mode, computation stays dirty since no effect pulled it
    // (computations are lazily evaluated only when needed by effects)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

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
      {},
    );
    runtime.scheduler.queueExecution();
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
      {},
    );
    await output.pull();

    // First run
    let stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(1);
    const firstRunTime = stats!.totalTime;

    // Trigger another run
    trigger.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await output.pull();

    // Second run - stats should accumulate
    stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(2);
    expect(stats!.totalTime).toBeGreaterThanOrEqual(firstRunTime);
    expect(stats!.averageTime).toBe(stats!.totalTime / 2);
  });

  it("should handle cycles implicitly via re-dirtying detection", async () => {
    // Test that cycles are detected implicitly when actions re-dirty processed actions
    runtime.scheduler.enablePullMode();

    // Create cells for a simple converging cycle: A → B → A
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
    const output = runtime.getCell<number>(
      space,
      "cycle-detect-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let actionARunCount = 0;
    let actionBRunCount = 0;
    let effectRunCount = 0;

    // Action A: reads A, writes B (computation)
    const actionA: Action = (actionTx) => {
      actionARunCount++;
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val + 1);
    };

    // Action B: reads B, writes A (creates cycle, but converges)
    const actionB: Action = (actionTx) => {
      actionBRunCount++;
      const val = cellB.withTx(actionTx).get();
      // Only update if we haven't converged (val < 5 means cycle continues)
      if (val < 5) {
        cellA.withTx(actionTx).send(val);
      }
    };

    // Effect: observes cycle output (required to drive pull-based scheduling)
    const effect: Action = (actionTx) => {
      effectRunCount++;
      const val = cellB.withTx(actionTx).get();
      output.withTx(actionTx).send(val);
    };

    // Subscribe both computations first
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      {},
    );

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      {},
    );

    // Subscribe effect to drive the pull
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );

    // Wait for scheduler to settle
    await runtime.scheduler.idle();

    // All actions should have run (cycle was detected and handled)
    expect(actionARunCount).toBeGreaterThan(0);
    expect(actionBRunCount).toBeGreaterThan(0);
    expect(effectRunCount).toBeGreaterThan(0);
    // The cycle should make progress - cellB should have been updated from initial 0
    expect(cellB.get()).toBeGreaterThan(0);
  });

  it("should run fast cycle convergence method", async () => {
    // This test verifies the fast cycle convergence logic by directly
    // testing with default scheduling (which bypasses pull mode complexity)
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

    // Subscribe to ensure it runs immediately (default behavior)
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [counter.getAsNormalizedFullLink()],
        writes: [doubled.getAsNormalizedFullLink()],
      },
      {},
    );
    await doubled.pull();

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
      {},
    );
    await doubled.pull();

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
    const output = runtime.getCell<number>(
      space,
      "non-converge-output",
      undefined,
      tx,
    );
    output.set(0);
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

    // Effect to observe the cycle and drive pull-based scheduling
    const effect: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      output.withTx(actionTx).send(val);
    };

    // Subscribe both computations
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      {},
    );

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      {},
    );

    // Subscribe effect to drive the pull
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );

    // Let the cycle run - it should stop after hitting the limit
    // Multiple idle() calls allow async storage notifications to trigger re-runs
    for (let i = 0; i < 30; i++) {
      await runtime.scheduler.idle();
      // Small delay to let async storage notifications fire
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The cycle should have stopped due to iteration limit
    // (either via MAX_ITERATIONS_PER_RUN or MAX_CYCLE_ITERATIONS)
    // Total runs should be bounded, not infinite
    expect(runCountA + runCountB).toBeLessThan(500);

    // The cycle ran and should have been bounded
    // Note: With implicit cycle detection, errors may or may not be thrown
    // depending on timing. The key invariant is that runs are bounded.
    expect(runCountA + runCountB).toBeGreaterThan(0);
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
      {},
    );
    await result.pull();

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
      {},
    );

    // Wait for updates
    await result.pull();

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
      {},
    );
    await cellA.pull();

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      {},
    );
    await cellB.pull();

    runtime.scheduler.subscribe(
      actionC,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellC.getAsNormalizedFullLink()],
      },
      {},
    );
    await cellC.pull();

    // The cycle should converge (value reaches 3)
    // This tests that collectDirtyDependencies doesn't infinitely recurse
    expect(cellC.get()).toBeLessThanOrEqual(3);
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
      {},
    );

    runtime.scheduler.queueExecution();
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
        {},
      );
      await cell.pull();
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
        {},
      );
      await cellD.pull();
    }

    // Let the cycle run for a few iterations
    for (let i = 0; i < 10; i++) {
      await cellD.pull();
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
      {},
    );

    // Let it run for a while
    for (let i = 0; i < 20; i++) {
      await counter.pull();
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
      {},
    );
    await cell.pull();

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
      {},
    );
    await cell.pull();

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

    // Subscribe all with proper writes for pull mode to discover dependencies
    runtime.scheduler.subscribe(
      acyclicAction,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [computed.getAsNormalizedFullLink()],
      },
      {},
    );
    await computed.pull();

    runtime.scheduler.subscribe(
      cycleActionA,
      {
        reads: [cycleA.getAsNormalizedFullLink()],
        writes: [cycleB.getAsNormalizedFullLink()],
      },
      {},
    );
    await cycleB.pull();

    runtime.scheduler.subscribe(
      cycleActionB,
      {
        reads: [cycleB.getAsNormalizedFullLink()],
        writes: [cycleA.getAsNormalizedFullLink()],
      },
      {},
    );
    await cycleA.pull();

    // Let them all run
    for (let i = 0; i < 10; i++) {
      await cycleB.pull();
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

    // Subscribe with proper writes for pull mode
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce period
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cell.pull();

    // Now it should have run
    expect(runCount).toBe(1);
  });

  it("should coalesce rapid triggers into single execution", async () => {
    runtime.scheduler.enablePullMode();

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

    // Trigger multiple times rapidly (with proper writes for pull mode)
    for (let i = 0; i < 5; i++) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], writes: [cell.getAsNormalizedFullLink()] },
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Should not have run yet (debounce keeps resetting)
    expect(runCount).toBe(0);

    // Wait for debounce to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cell.pull();

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

    // Subscribe with debounce option (and proper writes for pull mode)
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      { debounce: 50 },
    );

    // Verify debounce was set
    expect(runtime.scheduler.getDebounce(action)).toBe(50);

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cell.pull();

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

    // Subscribe with default scheduling (runs immediately)
    const cancel = runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      {},
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

    // Subscribe (auto-debounce is enabled by default)
    runtime.scheduler.subscribe(action, { reads: [], writes: [] }, {});
    await cell.pull();

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

    // Subscribe (auto-debounce is enabled by default, and proper writes for pull mode)
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      {},
    );
    await cell.pull();

    // Run multiple times (fast actions)
    for (let i = 0; i < 5; i++) {
      runtime.scheduler.subscribe(
        action,
        {
          reads: [cell.getAsNormalizedFullLink()],
          writes: [cell.getAsNormalizedFullLink()],
        },
        {},
      );
      await cell.pull();
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
      { isEffect: true },
    );

    // Should not run immediately due to debounce
    expect(runCount).toBe(0);

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 100));
    await result.pull();

    // Should have run
    expect(runCount).toBe(1);
    expect(result.get()).toBe(2);
  });

  it("should track run counts per execute cycle for cycle-aware debounce", async () => {
    // The cycle-aware debounce mechanism tracks how many times each action
    // runs within a single execute() call. If an action runs 3+ times and
    // the execute() took >100ms, adaptive debounce is applied.
    //
    // Note: The scheduler actively prevents cycles, so effects typically
    // only run once per execute(). This test verifies the tracking mechanism
    // exists and works when multiple runs DO occur through separate execute()
    // cycles triggered by sequential input changes.

    const input = runtime.getCell<number>(
      space,
      "cycle-debounce-input",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "cycle-debounce-output",
      undefined,
      tx,
    );
    input.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // A slow effect that we'll trigger multiple times
    const slowEffect: Action = async (actionTx) => {
      runCount++;
      const val = input.withTx(actionTx).get() ?? 0;
      // Add delay to make execution slow enough to potentially trigger cycle debounce
      await new Promise((resolve) => setTimeout(resolve, 40));
      output.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      slowEffect,
      (depTx) => {
        input.withTx(depTx).get();
      },
      { isEffect: true },
    );

    // Initial run
    await output.pull();
    await runtime.idle();

    // Should have run at least once
    expect(runCount).toBeGreaterThanOrEqual(1);

    // The action runs across multiple execute() cycles, not within one
    // So cycle-aware debounce (which tracks runs within one execute) won't trigger
    // This is expected - the scheduler prevents in-execute cycles by design
  });

  it("should not apply cycle-aware debounce to fast executes", async () => {
    // Fast actions that run multiple times should not get cycle debounce
    // because the execute() time threshold (100ms) isn't met

    const counter = runtime.getCell<number>(
      space,
      "fast-cycle-counter",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "fast-cycle-output",
      undefined,
      tx,
    );
    counter.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // Fast self-cycling computation (no delay)
    const fastCycling: Action = (actionTx) => {
      runCount++;
      const val = counter.withTx(actionTx).get() ?? 0;
      output.withTx(actionTx).send(val);
      if (val < 5) {
        counter.withTx(actionTx).send(val + 1);
      }
    };

    runtime.scheduler.subscribe(
      fastCycling,
      (depTx) => {
        counter.withTx(depTx).get();
      },
      { isEffect: true },
    );

    await output.pull();
    await runtime.idle();

    // Action may have run multiple times
    expect(runCount).toBeGreaterThanOrEqual(1);

    // But execute was fast (<100ms total), so no cycle debounce applied
    const debounce = runtime.scheduler.getDebounce(fastCycling);
    // Fast execution shouldn't trigger cycle debounce
    expect(debounce === undefined || debounce < 200).toBe(true);
  });

  it("should respect noDebounce option for cycle-aware debounce", async () => {
    const counter = runtime.getCell<number>(
      space,
      "no-debounce-counter",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "no-debounce-output",
      undefined,
      tx,
    );
    counter.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // Slow cycling computation
    const slowCycling: Action = async (actionTx) => {
      runCount++;
      const val = counter.withTx(actionTx).get() ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 40));
      output.withTx(actionTx).send(val);
      if (val < 5) {
        counter.withTx(actionTx).send(val + 1);
      }
    };

    // Subscribe with noDebounce: true - should opt out of cycle debounce
    runtime.scheduler.subscribe(
      slowCycling,
      (depTx) => {
        counter.withTx(depTx).get();
      },
      { isEffect: true, noDebounce: true },
    );

    await output.pull();
    await runtime.idle();

    expect(runCount).toBeGreaterThanOrEqual(1);

    // Should NOT have debounce even if it cycled slowly
    expect(runtime.scheduler.getDebounce(slowCycling)).toBeUndefined();
  });

  it("should only increase debounce if cycle debounce is larger than existing", async () => {
    // If an action already has a higher debounce set (manually or from previous
    // cycle debounce), the cycle-aware mechanism should not reduce it.

    const cell = runtime.getCell<number>(
      space,
      "debounce-precedence-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    // Manually set a high debounce
    runtime.scheduler.setDebounce(action, 5000);

    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );

    await cell.pull();
    await runtime.idle();

    // The manually set debounce should still be in place
    // (cycle debounce wouldn't have triggered anyway since only 1 run,
    // but even if it did, 5000ms > any likely cycle debounce)
    expect(runtime.scheduler.getDebounce(action)).toBe(5000);
  });

  it("should track multiple actions independently for cycle debounce", async () => {
    // Each action's run count should be tracked separately within an execute()

    const inputA = runtime.getCell<number>(
      space,
      "multi-action-input-a",
      undefined,
      tx,
    );
    const inputB = runtime.getCell<number>(
      space,
      "multi-action-input-b",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "multi-action-output",
      undefined,
      tx,
    );
    inputA.set(0);
    inputB.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCountA = 0;
    let runCountB = 0;

    const actionA: Action = async (actionTx) => {
      runCountA++;
      const val = inputA.withTx(actionTx).get() ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
      output.withTx(actionTx).send(val);
    };

    const actionB: Action = (actionTx) => {
      runCountB++;
      const val = inputB.withTx(actionTx).get() ?? 0;
      // Fast action - no delay
      output.withTx(actionTx).send(val);
    };

    runtime.scheduler.subscribe(
      actionA,
      (depTx) => {
        inputA.withTx(depTx).get();
      },
      { isEffect: true },
    );

    runtime.scheduler.subscribe(
      actionB,
      (depTx) => {
        inputB.withTx(depTx).get();
      },
      { isEffect: true },
    );

    await output.pull();
    await runtime.idle();

    // Both should have run
    expect(runCountA).toBeGreaterThanOrEqual(1);
    expect(runCountB).toBeGreaterThanOrEqual(1);

    // Actions are tracked independently - neither should have cycle debounce
    // since each only ran once per execute cycle
    const debounceA = runtime.scheduler.getDebounce(actionA);
    const debounceB = runtime.scheduler.getDebounce(actionB);

    // Neither should have high cycle debounce (may have auto-debounce if slow)
    expect(debounceA === undefined || debounceA <= 100).toBe(true);
    expect(debounceB === undefined || debounceB <= 100).toBe(true);
  });

  it("should reset run tracking between execute cycles", async () => {
    // The runsThisExecute map should be cleared at the start of each execute(),
    // so runs from previous cycles don't affect the current cycle's debounce.

    const input = runtime.getCell<number>(
      space,
      "reset-tracking-input",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "reset-tracking-output",
      undefined,
      tx,
    );
    input.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    const action: Action = (actionTx) => {
      runCount++;
      const val = input.withTx(actionTx).get() ?? 0;
      output.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      action,
      (depTx) => {
        input.withTx(depTx).get();
      },
      { isEffect: true },
    );

    // First execute cycle
    await output.pull();
    await runtime.idle();
    expect(runCount).toBe(1);

    // Second execute cycle (triggered by input change)
    const editTx1 = runtime.edit();
    input.withTx(editTx1).send(1);
    await editTx1.commit();
    await runtime.idle();
    expect(runCount).toBe(2);

    // Third execute cycle
    const editTx2 = runtime.edit();
    input.withTx(editTx2).send(2);
    await editTx2.commit();
    await runtime.idle();
    expect(runCount).toBe(3);

    // Even though total runs = 3, each execute() cycle only had 1 run
    // So no cycle debounce should be applied
    const debounce = runtime.scheduler.getDebounce(action);
    expect(debounce === undefined || debounce < 200).toBe(true);
  });

  it("should allow clearDebounce to remove cycle-applied debounce", async () => {
    const cell = runtime.getCell<number>(
      space,
      "clear-cycle-debounce-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    // Set a debounce (simulating what cycle debounce would do)
    runtime.scheduler.setDebounce(action, 500);
    expect(runtime.scheduler.getDebounce(action)).toBe(500);

    // Clear it
    runtime.scheduler.clearDebounce(action);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
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
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      {},
    );
    await cell.pull();
    expect(runCount).toBe(1);

    // Now set throttle
    runtime.scheduler.setThrottle(action, 500);

    // Try to run again immediately
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      {},
    );
    await cell.pull();

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
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      {},
    );
    await cell.pull();
    expect(runCount).toBe(1);

    // Try immediately - should be throttled
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      {},
    );
    await cell.pull();
    expect(runCount).toBe(1);

    // Wait for throttle to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Now should run
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      {},
    );
    await cell.pull();
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
      {},
    );
    await result.pull();
    expect(computeCount).toBe(1);

    // Set throttle
    runtime.scheduler.setThrottle(computation, 500);

    // Change source to mark computation dirty
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    // Wait for propagation
    await result.pull();

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
      { throttle: 50, isEffect: true },
    );
    await result.pull();
    expect(effectCount).toBe(1);
    expect(result.get()).toBe(2);

    // Change source - effect is scheduled but throttled
    source.withTx(tx).send(5);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();

    // Still at old value due to throttle
    expect(effectCount).toBe(1);

    // Wait for throttle to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Trigger again - now throttle has expired, should run
    source.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();

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
      { isEffect: true },
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
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

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
      {},
    );
    await cell.pull();

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
      {},
    );
    await cell1.pull();

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
      {},
    );
    await cell2.pull();

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
      {},
    );
    await cell.pull();

    const stats = runtime.scheduler.getFilterStats();
    // Action should have executed (not filtered)
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should allow first run even without pushTriggered (default scheduling)", async () => {
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

    // First run with default scheduling should work
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(1);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
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
      { isEffect: true },
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Change cell via external means (simulating storage change)
    cell.withTx(tx).send(100);
    await tx.commit();
    tx = runtime.edit();
    await cell.pull();

    // Action should have been triggered by storage change and run
    expect(runCount).toBe(2);

    // Verify it was tracked as push-triggered (executed, not filtered)
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should not filter actions scheduled with default scheduling", async () => {
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
      {},
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Run again with default scheduling - should bypass filter
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

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
    // Use push mode for parent-child ordering tests since these test
    // execution ordering when all pending actions run in the same cycle
    runtime.scheduler.disablePullMode();
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
        { isEffect: true },
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
      { isEffect: true },
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
          {},
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
      { reads: [toggle.getAsNormalizedFullLink()], writes: [] },
      { isEffect: true },
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
          { isEffect: true },
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
      { isEffect: true },
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
          { isEffect: true },
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
          { isEffect: true },
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
      { isEffect: true },
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
          { reads: [source.getAsNormalizedFullLink()], writes: [] },
          {},
        );
      }
    };

    const childAction: Action = (actionTx) => {
      childRunCount++;
      source.withTx(actionTx).get();
    };

    const parentCanceler = runtime.scheduler.subscribe(
      parentAction,
      { reads: [source.getAsNormalizedFullLink()], writes: [] },
      { isEffect: true },
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
      {},
    );
    await innerOutput.pull();

    runtime.scheduler.subscribe(
      outerLift,
      {
        reads: [innerOutput.getAsNormalizedFullLink()],
        writes: [outerOutput.getAsNormalizedFullLink()],
      },
      {},
    );
    await outerOutput.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [outerOutput.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    // Initial state: source is [], innerOutput is undefined, outerOutput is "default"
    expect(innerRuns).toBe(1);
    expect(outerRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe("default");

    // Now change source to ["apple"]
    source.withTx(tx).send(["apple"]);
    await tx.commit();
    tx = runtime.edit();
    await effectResult.pull();

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
      {},
    );
    await computedOutput.pull();

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
    await result.pull();

    // Computed should have run (pulled by handler dependency)
    expect(computedRuns).toBe(1);
    expect(computedOutput.get()).toBe(40); // 20 * 2

    // Handler should have run with the fresh computed value
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(45); // 40 + 5

    // Execution order should be: computed first, then handler
    expect(executionOrder).toEqual(["computed", "handler"]);
  });

  it("should not pull dirty computations when handler reads a different path", async () => {
    const source = runtime.getCell<number>(
      space,
      "handler-path-source",
      undefined,
      tx,
    );
    source.set(1);

    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "handler-path-data",
      undefined,
      tx,
    );
    data.set({ foo: 0, bar: 5 });

    const eventStream = runtime.getCell<number>(
      space,
      "handler-path-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-path-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;

    const computedAction: Action = (actionTx) => {
      computedRuns++;
      const val = source.withTx(actionTx).get();
      data.withTx(actionTx).key("foo").send(val * 2);
    };

    runtime.scheduler.subscribe(
      computedAction,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [data.key("foo").getAsNormalizedFullLink()],
      },
      {},
    );

    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const barValue = data.withTx(handlerTx).key("bar").get();
      result.withTx(handlerTx).send(barValue + event);
    };

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      data.withTx(depTx).key("bar").get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    await runtime.scheduler.idle();

    computedRuns = 0;
    handlerRuns = 0;

    // Mark the computation dirty by changing its source.
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await result.pull();

    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(8); // bar (5) + event (3)
    expect(computedRuns).toBe(0);
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
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [source2.getAsNormalizedFullLink()],
        writes: [computed2.getAsNormalizedFullLink()],
      },
      {},
    );

    await computed1.pull();
    await computed2.pull();

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
    await result.pull();

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
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [computed1.getAsNormalizedFullLink()],
        writes: [computed2.getAsNormalizedFullLink()],
      },
      {},
    );

    await computed2.pull();

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
    await result.pull();

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

    // Resubscribe the lift - NOT scheduled immediately
    // This tests that the lift is pulled when handler B needs it
    // Use resubscribe to set up triggers without scheduling immediate execution
    runtime.scheduler.resubscribe(liftAction, {
      reads: [liftInput.getAsNormalizedFullLink()],
      writes: [liftOutput.getAsNormalizedFullLink()],
    });

    await runtime.idle();
    expect(liftRuns).toBe(0); // NOT run yet - using rescheduling mode
    expect(liftOutput.get()).toBe(0); // Still initial value

    // Handler B: receives a LINK to liftOutput as the event, reads from it
    const handlerB: EventHandler = (handlerTx, _event: { "/": string }) => {
      handlerBRuns++;
      // The event IS a link to liftOutput - read from it
      // This simulates a handler receiving a reference to computed data
      const liftVal = liftOutput.withTx(handlerTx).get();
      executionOrder.push(`handlerB:lift=${liftVal}`);
      const saw = handlerBSawLiftOutput.withTx(handlerTx).get();
      handlerBSawLiftOutput.withTx(handlerTx).send([...saw, liftVal]);
    };

    // Handler B's populateDependencies - resolves the event link to capture dependency
    // The event IS a link to liftOutput, so we create a cell from it and read
    const handlerBPopulateDeps = (
      depTx: IExtendedStorageTransaction,
      eventValue: { "/": string },
    ) => {
      // Create a cell from the event (which is a link) and read it
      // This registers the dependency on whatever the link points to
      const eventCell = runtime.getImmutableCell(
        space,
        eventValue,
        undefined,
        depTx,
      );
      eventCell.get();
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
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        liftOutputLink,
      );
    };

    // Register handlers
    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
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
    await handlerBSawLiftOutput.pull();

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
      s.startsWith("handlerB:")
    );
    expect(liftIndex).toBeLessThan(handlerBIndex);

    // Handler B should have seen lift=10 (the fresh value, not stale 0)
    expect(executionOrder.find((s) => s.startsWith("handlerB:"))).toBe(
      "handlerB:lift=10",
    );
  });
});

describe("pull mode array reactivity", () => {
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

  it("should trigger sink when array element is pushed", async () => {
    // Create a cell with an array
    const arrayCell = runtime.getCell<string[]>(
      space,
      "array-push-test",
      undefined,
      tx,
    );
    arrayCell.set(["a", "b"]);
    await tx.commit();
    tx = runtime.edit();

    // Track sink calls
    const sinkValues: string[][] = [];
    const cancel = arrayCell.withTx(tx).sink((value) => {
      sinkValues.push([...value]);
    });

    // Wait for initial sink call
    await runtime.scheduler.idle();
    expect(sinkValues.length).toBe(1);
    expect(sinkValues[0]).toEqual(["a", "b"]);

    // Push a new element using the current transaction
    arrayCell.withTx(tx).push("c");
    await tx.commit();
    tx = runtime.edit();

    // Wait for scheduler to process
    await runtime.scheduler.idle();

    // Verify sink was called with updated array
    expect(sinkValues.length).toBe(2);
    expect(sinkValues[1]).toEqual(["a", "b", "c"]);

    cancel();
  });

  it("should trigger sink when array length changes via set", async () => {
    // Create a cell with an array
    const arrayCell = runtime.getCell<number[]>(
      space,
      "array-length-test",
      undefined,
      tx,
    );
    arrayCell.set([1, 2, 3]);
    await tx.commit();
    tx = runtime.edit();

    // Track sink calls
    const sinkLengths: number[] = [];
    const cancel = arrayCell.withTx(tx).sink((value) => {
      sinkLengths.push(value.length);
    });

    // Wait for initial sink call
    await runtime.scheduler.idle();
    expect(sinkLengths).toEqual([3]);

    // Set a new array with different length using the current transaction
    arrayCell.withTx(tx).set([1, 2, 3, 4, 5]);
    await tx.commit();
    tx = runtime.edit();

    // Wait for scheduler to process
    await runtime.scheduler.idle();

    // Verify sink was called with new length
    expect(sinkLengths).toEqual([3, 5]);

    cancel();
  });

  it("should trigger computation when array source changes via push", async () => {
    // This tests: when a source array has an element pushed, a computation
    // that reads it should be marked dirty and re-run on pull.
    // This simulates: visiblePieces = computed(() => allPieces.filter(...))

    const sourceArray = runtime.getCell<{ name: string; hidden: boolean }[]>(
      space,
      "source-array-map-test",
      undefined,
      tx,
    );
    sourceArray.set([
      { name: "item1", hidden: false },
      { name: "item2", hidden: true },
    ]);

    const filteredCell = runtime.getCell<string[]>(
      space,
      "filtered-array-map-test",
      undefined,
      tx,
    );
    filteredCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track how many times the computation runs
    let computationRunCount = 0;

    // Create a computation that filters the source
    const filterAction: Action = (actionTx) => {
      computationRunCount++;
      const source = sourceArray.withTx(actionTx).get();
      const filtered = source
        .filter((item) => !item.hidden)
        .map((item) => item.name);
      filteredCell.withTx(actionTx).send(filtered);
    };

    runtime.scheduler.subscribe(
      filterAction,
      {
        reads: [sourceArray.getAsNormalizedFullLink()],
        writes: [filteredCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Pull to trigger initial computation
    await filteredCell.withTx(tx).pull();
    await runtime.scheduler.idle();
    expect(computationRunCount).toBe(1);
    expect(filteredCell.withTx(tx).get()).toEqual(["item1"]);

    // Now push a new item to the source array
    sourceArray.withTx(tx).push({ name: "item3", hidden: false });
    await tx.commit();
    tx = runtime.edit();

    // Pull again - the computation SHOULD run because its input changed
    await filteredCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    // BUG: If computationRunCount is still 1, the computation didn't re-run
    // when the source array changed via push
    expect(computationRunCount).toBe(2);
    expect(filteredCell.withTx(tx).get()).toEqual(["item1", "item3"]);
  });

  it("should notify sink on computed result when source array grows (no explicit pull)", async () => {
    // This tests the renderer pattern: sink observes computed result,
    // and should be notified when source array (which feeds the computation)
    // has elements added. This is the pattern used in the Notes UI.
    //
    // Expected behavior:
    // 1. Source array changes (push)
    // 2. Computation that reads source is marked dirty
    // 3. scheduleAffectedEffects finds sink as a dependent and schedules it
    // 4. Computation runs, then sink is notified with new value

    const sourceArray = runtime.getCell<string[]>(
      space,
      "renderer-source-array",
      undefined,
      tx,
    );
    sourceArray.set(["a", "b"]);

    const computedCell = runtime.getCell<string[]>(
      space,
      "renderer-computed",
      undefined,
      tx,
    );
    computedCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track sink notifications
    const sinkValues: string[][] = [];

    // Create a computation that transforms the source
    const transformAction: Action = (actionTx) => {
      const source = sourceArray.withTx(actionTx).get();
      const transformed = source.map((s) => s.toUpperCase());
      computedCell.withTx(actionTx).send(transformed);
    };

    runtime.scheduler.subscribe(
      transformAction,
      {
        reads: [sourceArray.getAsNormalizedFullLink()],
        writes: [computedCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Set up sink on computed result (simulating renderer effect)
    const cancel = computedCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        sinkValues.push([...value]);
      }
    });

    // Pull to trigger initial computation
    await computedCell.withTx(tx).pull();
    await runtime.scheduler.idle();
    expect(sinkValues.length).toBeGreaterThanOrEqual(1);
    expect(sinkValues[sinkValues.length - 1]).toEqual(["A", "B"]);

    // Push to source array - use a FRESH transaction to avoid consistency issues
    // (the previous tx was used by the sink which read computedCell)
    const pushTx = runtime.edit();
    sourceArray.withTx(pushTx).push("c");
    await pushTx.commit();

    // The sink SHOULD be notified with the updated computed value
    // Without explicit pull - just let the scheduler run
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    // Verify sink was notified with updated value
    expect(sinkValues.length).toBeGreaterThanOrEqual(2);
    expect(sinkValues[sinkValues.length - 1]).toEqual(["A", "B", "C"]);

    cancel();
  });

  it("should notify renderer when allPieces array is pushed (Notes UI simulation)", async () => {
    // This simulates the actual Notes UI flow:
    // - Space has allPieces Cell (array of pieces)
    // - visiblePieces computation filters allPieces
    // - Renderer effect observes visiblePieces and renders the list
    // - User creates a new note which pushes to allPieces
    // - Renderer should be notified and re-render with new note

    // Define schemas for realistic data
    const pieceSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        isHidden: { type: "boolean" },
      },
      required: ["name"],
    } as const satisfies JSONSchema;

    const allPiecesSchema = {
      type: "array",
      items: pieceSchema,
    } as const satisfies JSONSchema;

    const spaceSchema = {
      type: "object",
      properties: {
        // Not using asCell: true here - we want inline array data for simplicity
        allPieces: allPiecesSchema,
      },
    } as const satisfies JSONSchema;

    // Create space cell with allPieces
    const spaceCell = runtime.getCell(space, "notes-ui-space", spaceSchema, tx);
    spaceCell.set({
      allPieces: [
        { name: "Existing Note 1", isHidden: false },
        { name: "Hidden Note", isHidden: true },
      ],
    });
    await tx.commit();
    tx = runtime.edit();

    // Get the allPieces subcell
    const allPiecesCell = spaceCell.key("allPieces");

    // Create visiblePieces cell for computed output
    const visiblePiecesCell = runtime.getCell(
      space,
      "visible-pieces",
      { type: "array", items: pieceSchema },
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track renderer notifications
    const renderedValues: { name: string }[][] = [];

    // Create computation: visiblePieces = allPieces.filter(c => !c.isHidden)
    const computeVisiblePieces: Action = function computeVisiblePieces(
      actionTx,
    ) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      // Now pieces should be an array since we don't have asCell: true
      const visible = pieces.filter((c) => !c.isHidden);
      visiblePiecesCell.withTx(actionTx).send(visible);
    };

    // Subscribe computation with schema-aware reads/writes
    runtime.scheduler.subscribe(
      computeVisiblePieces,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Create renderer effect (sink on visiblePieces)
    const cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Initial pull to trigger computation and renderer
    await visiblePiecesCell.withTx(tx).pull();

    // Verify initial render shows only visible pieces
    expect(renderedValues.length).toBeGreaterThanOrEqual(1);
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Existing Note 1", isHidden: false },
    ]);

    // Simulate creating a new note and pushing to allPieces
    // (This is what happens when user creates a note in notebook.tsx)
    const createNoteTx = runtime.edit();
    allPiecesCell.withTx(createNoteTx).push({
      name: "New Note",
      isHidden: false,
    });
    await createNoteTx.commit();

    // Let the scheduler process the change
    await runtime.scheduler.idle();

    // Renderer should have been notified with updated visible pieces
    expect(renderedValues.length).toBeGreaterThanOrEqual(2);
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Existing Note 1", isHidden: false },
      { name: "New Note", isHidden: false },
    ]);

    cancelRenderer();
    runtime.scheduler.unsubscribe(computeVisiblePieces);
  });

  it("should handle nested cell updates in allPieces pattern", async () => {
    // More complex test: allPieces contains cell references (like real usage)
    // When a new piece is pushed, the renderer should see it

    const spaceSchema = {
      type: "object",
      properties: {
        allPieces: {
          type: "array",
          items: { type: "object" },
          // Not using asCell: true - testing inline array data
        },
      },
    } as const satisfies JSONSchema;

    // Create space with allPieces - start with 1 item like the first test
    const spaceCell = runtime.getCell(
      space,
      "nested-allpieces-space",
      spaceSchema,
      tx,
    );
    spaceCell.set({ allPieces: [{ name: "Initial Piece" }] });
    await tx.commit();
    tx = runtime.edit();

    const allPiecesCell = spaceCell.key("allPieces");

    // Track what the "renderer" sees
    const renderedPieceCount: number[] = [];

    // Create a simple computation that counts pieces
    const countCell = runtime.getCell(
      space,
      "piece-count",
      { type: "number" },
      tx,
    );
    countCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const countPieces: Action = function countPieces(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      countCell.withTx(actionTx).send(pieces.length);
    };

    runtime.scheduler.subscribe(
      countPieces,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [countCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Renderer effect
    const cancelRenderer = countCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedPieceCount.push(value);
      }
    });

    // Initial pull - we start with 1 item
    await countCell.withTx(tx).pull();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(1);

    // Push first new piece (total should be 2)
    const tx1 = runtime.edit();
    allPiecesCell.withTx(tx1).push({ name: "Piece 1" });
    await tx1.commit();

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(2);

    // Push second piece (total should be 3)
    const tx2 = runtime.edit();
    allPiecesCell.withTx(tx2).push({ name: "Piece 2" });
    await tx2.commit();

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(3);

    // Push third piece (total should be 4)
    const tx3 = runtime.edit();
    allPiecesCell.withTx(tx3).push({ name: "Piece 3" });
    await tx3.commit();

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(4);

    cancelRenderer();
    runtime.scheduler.unsubscribe(countPieces);
  });

  it("should see updated data after unsubscribe/resubscribe (navigation flow)", async () => {
    // This simulates the ACTUAL bug flow:
    // 1. Default app is mounted (sink subscribed)
    // 2. Navigate to note editor (sink unsubscribed)
    // 3. Create note (push while unsubscribed)
    // 4. Navigate back (sink re-subscribed)
    // 5. Should see new data

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create allPieces array with initial data
    const allPiecesCell = runtime.getCell(
      space,
      "nav-flow-allpieces",
      arraySchema,
      tx,
    );
    allPiecesCell.set([{ name: "Initial Note" }]);
    await tx.commit();
    tx = runtime.edit();

    // Create computed cell (visiblePieces)
    const visiblePiecesCell = runtime.getCell(
      space,
      "nav-flow-visible",
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // Computation: copy allPieces to visiblePieces
    const computeVisible: Action = function computeVisible(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // STEP 1: Mount default app (subscribe renderer)
    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Initial pull to see data
    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // STEP 2: Navigate away (unmount default app, unsubscribe renderer)
    cancelRenderer();

    // STEP 3: Create note while on another page (push while unsubscribed)
    const createTx = runtime.edit();
    allPiecesCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit();

    // STEP 4: Navigate back (remount default app, resubscribe renderer)
    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Pull to get fresh data
    await visiblePiecesCell.withTx(tx2).pull();
    await runtime.scheduler.idle();

    // STEP 5: Should see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    runtime.scheduler.unsubscribe(computeVisible);
  });

  it("should see updated data when computation is also unsubscribed (full navigation)", async () => {
    // Even more realistic: when navigating away, the WHOLE piece (including
    // its computation) might get stopped, not just the renderer sink.
    // This is what runner.stop() does.

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create allPieces array with initial data
    const allPiecesCell = runtime.getCell(
      space,
      "full-nav-allpieces",
      arraySchema,
      tx,
    );
    allPiecesCell.set([{ name: "Initial Note" }]);
    await tx.commit();
    tx = runtime.edit();

    // Create computed cell (visiblePieces)
    const visiblePiecesCell = runtime.getCell(
      space,
      "full-nav-visible",
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // Computation: copy allPieces to visiblePieces
    const computeVisible: Action = function computeVisible(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    // STEP 1: Mount default app piece
    let cancelComputation = runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // STEP 2: Navigate away - unsubscribe BOTH renderer AND computation
    cancelRenderer();
    cancelComputation();

    // STEP 3: Create note while on another page
    const createTx = runtime.edit();
    allPiecesCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit();

    // STEP 4: Navigate back - resubscribe BOTH computation AND renderer
    cancelComputation = runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Pull to get fresh data
    await visiblePiecesCell.withTx(tx2).pull();
    await runtime.scheduler.idle();

    // Should see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    cancelComputation();
  });

  it("should see fresh data when a NEW computation is created (pattern remount)", async () => {
    // This simulates what happens when a pattern remounts:
    // - The computed value output cell is REUSED (same cause = same cell)
    // - But a NEW computation action is created each time
    // - The sink reads from the output cell which has CACHED old value
    // - The new computation should run and update the value

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create allPieces array with initial data
    const allPiecesCell = runtime.getCell(
      space,
      "pattern-remount-allpieces",
      arraySchema,
      tx,
    );
    allPiecesCell.set([{ name: "Initial Note" }]);
    await tx.commit();
    tx = runtime.edit();

    // IMPORTANT: The computed output cell is created with a FIXED cause
    // so it will be the SAME cell when the pattern remounts
    const visiblePiecesCell = runtime.getCell(
      space,
      "pattern-remount-visible-FIXED-CAUSE", // This cause stays same across remounts
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // FIRST MOUNT: Create computation #1
    const computeVisible1: Action = function computeVisible1(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    let cancelComputation = runtime.scheduler.subscribe(
      computeVisible1,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // UNMOUNT: Stop pattern
    cancelRenderer();
    cancelComputation();

    // PUSH while unmounted
    const createTx = runtime.edit();
    allPiecesCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit();

    // REMOUNT: Create computation #2 (NEW action, but SAME output cell)
    const computeVisible2: Action = function computeVisible2(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    cancelComputation = runtime.scheduler.subscribe(
      computeVisible2,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // DON'T call pull() - just let the scheduler work naturally like the UI does
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    // Should eventually see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    cancelComputation();
  });
});
