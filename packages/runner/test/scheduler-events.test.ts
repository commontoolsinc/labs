// Scheduler event handling tests.

import {
  getLoggerCountsBreakdown,
  resetAllLoggerCounts,
} from "@commonfabric/utils/logger";
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
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Entity,
  EventHandler,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";

async function waitForSchedulerCondition(
  runtime: Runtime,
  condition: () => boolean,
) {
  const deadline = performance.now() + 1_000;
  while (!condition() && performance.now() < deadline) {
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForSignal(signal: Promise<void>, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe("event handling", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
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

  it("awaits presyncInputs before running the handler body", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "presync before handler 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "presync before handler 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    const order: string[] = [];
    let releasePresync!: () => void;
    const presyncDone = new Promise<void>((resolve) => {
      releasePresync = resolve;
    });

    const eventHandler: EventHandler = (tx, event) => {
      order.push("handler");
      eventResultCell.withTx(tx).send(event);
    };
    eventHandler.presyncInputs = async (event) => {
      order.push(`presync:${event}`);
      await presyncDone;
      order.push("presync-resolved");
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 7);

    // Give the scheduler a chance to dispatch; the handler must not run while
    // presync is pending.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["presync:7"]);

    releasePresync();
    await eventResultCell.pull();

    expect(order).toEqual(["presync:7", "presync-resolved", "handler"]);
    expect(eventResultCell.get()).toBe(7);
  });

  it("dispatches the handler even when presyncInputs rejects (fail open)", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "presync fail open 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "presync fail open 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    const eventHandler: EventHandler = (tx, event) => {
      eventResultCell.withTx(tx).send(event);
    };
    eventHandler.presyncInputs = () =>
      Promise.reject(new Error("presync boom"));

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 3);

    await eventResultCell.pull();
    expect(eventResultCell.get()).toBe(3);
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

  it("replaces an existing handler for the same event link", async () => {
    resetAllLoggerCounts();
    const eventCell = runtime.getCell<number>(
      space,
      "single handler per link event",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<string[]>(
      space,
      "single handler per link payloads",
      undefined,
      tx,
    );
    eventCell.set(0);
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    let firstCount = 0;
    let secondCount = 0;
    const firstHandler: EventHandler = (handlerTx, event) => {
      firstCount++;
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, `first:${event}`]);
    };
    const secondHandler: EventHandler = (handlerTx, event) => {
      secondCount++;
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, `second:${event}`]);
    };

    runtime.scheduler.addEventHandler(
      firstHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      secondHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 42);

    await waitForSignal(
      runtime.idle(),
      "replacement handler event did not settle",
    );

    expect(firstCount).toBe(0);
    expect(secondCount).toBe(1);
    expect(payloads.get()).toEqual(["second:42"]);
    expect(
      getLoggerCountsBreakdown().scheduler?.["event-handler-replaced"]?.warn,
    ).toBe(1);
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

  it("should dispatch queued event commits without waiting for server confirmation", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should dispatch queued event commits without waiting for server confirmation 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const listCell = runtime.getCell<number[]>(
      space,
      "should dispatch queued event commits without waiting for server confirmation 2",
      {
        type: "array",
        items: { type: "number" },
        default: [],
      },
      tx,
    );
    listCell.set([]);
    await tx.commit();

    let eventCount = 0;
    let commitWasStarted = false;
    let resolveCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      resolveCommitStarted = resolve;
    });
    let releaseCommit!: () => void;
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let resolveCommitFinished!: () => void;
    const commitFinished = new Promise<void>((resolve) => {
      resolveCommitFinished = resolve;
    });

    const eventHandler: EventHandler = (handlerTx, event) => {
      eventCount++;
      listCell.withTx(handlerTx).push(event);
      const originalCommit = handlerTx.commit.bind(handlerTx);
      handlerTx.commit = () => {
        commitWasStarted = true;
        resolveCommitStarted();
        return originalCommit().then(async (result) => {
          await commitRelease;
          return result;
        }).finally(resolveCommitFinished);
      };
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);

    const idlePromise = runtime.idle();
    let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitForSignal(commitStarted, "queued event commit did not start");
      const idleResult = await Promise.race([
        idlePromise.then(() => "resolved" as const),
        new Promise<"blocked">((resolve) => {
          idleTimeoutId = setTimeout(() => resolve("blocked"), 500);
        }),
      ]);

      expect(idleResult).toBe("resolved");
      expect(eventCount).toBe(1);
    } finally {
      if (idleTimeoutId !== undefined) clearTimeout(idleTimeoutId);
      releaseCommit();
      await idlePromise.catch(() => {});
      if (commitWasStarted) {
        await waitForSignal(
          commitFinished,
          "queued event commit did not finish after release",
        );
      }
    }

    await listCell.pull();

    expect(listCell.get()).toEqual([1]);
  });

  it("should cap event commit telemetry write samples", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should cap event commit telemetry write samples 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const targetCells = Array.from({ length: 40 }, (_, index) => {
      const cell = runtime.getCell<number>(
        space,
        `should cap event commit telemetry write samples target ${index}`,
        undefined,
        tx,
      );
      cell.set(0);
      return cell;
    });
    await tx.commit();

    const commitMarkers: RuntimeTelemetryMarker[] = [];
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{
        marker: RuntimeTelemetryMarker;
      }>).detail.marker;
      if (marker.type === "scheduler.event.commit") {
        commitMarkers.push(marker);
      }
    };
    runtime.telemetry.addEventListener("telemetry", listener);

    try {
      const eventHandler: EventHandler = (handlerTx, event) => {
        for (const cell of targetCells) {
          cell.withTx(handlerTx).set(event);
        }
      };
      runtime.scheduler.addEventHandler(
        eventHandler,
        eventCell.getAsNormalizedFullLink(),
      );

      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
      await waitForSchedulerCondition(runtime, () => commitMarkers.length > 0);

      const marker = commitMarkers.at(-1);
      expect(marker?.type).toBe("scheduler.event.commit");
      if (marker?.type === "scheduler.event.commit") {
        expect(marker.writeCount).toBe(40);
        expect(marker.writes.length).toBe(25);
        expect(marker.writesTruncated).toBe(true);
      }
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("should preserve queued event appends to multiple arrays", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should preserve queued event appends to multiple arrays 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const firstList = runtime.getCell<number[]>(
      space,
      "should preserve queued event appends to multiple arrays 2",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    firstList.set([]);
    const secondList = runtime.getCell<number[]>(
      space,
      "should preserve queued event appends to multiple arrays 3",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    secondList.set([]);
    await tx.commit();

    let eventCount = 0;
    const eventHandler: EventHandler = (handlerTx, event) => {
      eventCount++;
      firstList.withTx(handlerTx).push(event);
      secondList.withTx(handlerTx).push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    for (let i = 1; i <= 7; i++) {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), i);
    }

    await runtime.idle();
    await firstList.pull();
    await secondList.pull();

    expect(eventCount).toBe(7);
    expect(firstList.get()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(secondList.get()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("should recompute array length after rapid queued event appends", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should recompute array length after rapid queued event appends 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const listCell = runtime.getCell<number[]>(
      space,
      "should recompute array length after rapid queued event appends 2",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    listCell.set([]);
    const countCell = runtime.getCell<number>(
      space,
      "should recompute array length after rapid queued event appends 3",
      { type: "number", default: 0 },
      tx,
    );
    countCell.set(0);
    await tx.commit();

    const countRuns: number[] = [];
    const countItems = (actionTx: IExtendedStorageTransaction) => {
      const itemCount = listCell.withTx(actionTx).get().length;
      countRuns.push(itemCount);
      countCell.withTx(actionTx).send(itemCount);
    };

    runtime.scheduler.subscribe(
      countItems,
      {
        reads: [toMemorySpaceAddress(listCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(countCell.getAsNormalizedFullLink())],
      },
      {},
    );
    await countCell.pull();

    const renderedCounts: number[] = [];
    const cancelCountSink = countCell.withTx(runtime.edit()).sink((value) => {
      if (value !== undefined) {
        renderedCounts.push(value);
      }
    });

    const eventHandler: EventHandler = (handlerTx, event) => {
      listCell.withTx(handlerTx).push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    for (let i = 1; i <= 7; i++) {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), i);
    }

    await runtime.idle();

    expect(countRuns.at(-1)).toBe(7);
    expect(countCell.get()).toBe(7);
    expect(renderedCounts.at(-1)).toBe(7);

    cancelCountSink();
    runtime.scheduler.unsubscribe(countItems);
  });

  it("should rerun demanded computation dirtied during an in-flight run", async () => {
    const listCell = runtime.getCell<number[]>(
      space,
      "should rerun demanded computation dirtied during an in-flight run 1",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    listCell.set([1, 2, 3, 4, 5]);
    const countCell = runtime.getCell<number>(
      space,
      "should rerun demanded computation dirtied during an in-flight run 2",
      { type: "number", default: 0 },
      tx,
    );
    countCell.set(0);
    await tx.commit();

    let blockAtSix = false;
    let releaseSix: (() => void) | undefined;
    const releasedSix = new Promise<void>((resolve) => {
      releaseSix = resolve;
    });
    let observedSix: (() => void) | undefined;
    const observedSixRun = new Promise<void>((resolve) => {
      observedSix = resolve;
    });
    const countRuns: number[] = [];
    const countItems = async (actionTx: IExtendedStorageTransaction) => {
      const itemCount = listCell.withTx(actionTx).get().length;
      countRuns.push(itemCount);
      if (blockAtSix && itemCount === 6) {
        observedSix?.();
        await releasedSix;
      }
      countCell.withTx(actionTx).send(itemCount);
    };

    runtime.scheduler.subscribe(
      countItems,
      {
        reads: [toMemorySpaceAddress(listCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(countCell.getAsNormalizedFullLink())],
      },
      {},
    );

    let demandedPull: Promise<unknown> | undefined;
    try {
      await countCell.pull();
      expect(countCell.get()).toBe(5);

      blockAtSix = true;
      const appendSixTx = runtime.edit();
      listCell.withTx(appendSixTx).push(6);
      await appendSixTx.commit();

      demandedPull = countCell.pull();
      await waitForSignal(
        observedSixRun,
        "timed out waiting for blocked six-item computation run",
      );

      const appendSevenTx = runtime.edit();
      listCell.withTx(appendSevenTx).push(7);
      await appendSevenTx.commit();

      releaseSix?.();
      await demandedPull;
      await runtime.idle();
      await countCell.pull();

      expect(countRuns).toContain(6);
      expect(countRuns.at(-1)).toBe(7);
      expect(countCell.get()).toBe(7);
    } finally {
      releaseSix?.();
      await demandedPull?.catch(() => undefined);
      runtime.scheduler.unsubscribe(countItems);
    }
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
    }, { isEffect: true });
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

      await waitForSchedulerCondition(runtime, () => attempts >= 6);

      // Should attempt initial + default retries times (DEFAULT_RETRIES=5)
      expect(attempts).toBe(6);

      // No further assertions needed; this verifies retry behavior only.
    },
  );
});
