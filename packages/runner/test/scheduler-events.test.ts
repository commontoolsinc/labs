// Scheduler event handling tests.

import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
} from "./scheduler-test-utils.ts";
import type {
  Entity,
  EventHandler,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("event handling", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { pullMode: "disabled" },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
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

  it("does not commit or flush outbox effects when event handler throws", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "does not commit or flush outbox effects when event handler throws 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const resultCell = runtime.getCell<number>(
      space,
      "does not commit or flush outbox effects when event handler throws 2",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();

    let attempts = 0;
    let errors = 0;
    let flushed = 0;
    runtime.scheduler.onError(() => {
      errors++;
    });

    const eventHandler: EventHandler = (handlerTx) => {
      attempts++;
      resultCell.withTx(handlerTx).send(1);
      handlerTx.enqueuePostCommitEffect({
        id: "event-handler-throw-outbox",
        kind: "test",
        flush() {
          flushed++;
        },
      });
      throw new Error("boom");
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();
    await runtime.idle();

    expect(attempts).toBe(1);
    expect(errors).toBe(1);
    expect(flushed).toBe(0);
    expect(resultCell.get()).toBe(0);
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
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
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
    "should retry event handler when the handler transaction aborts, up to retries count",
    async () => {
      const entityId = `test:retry-conflict-${Date.now()}` as Entity;

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
