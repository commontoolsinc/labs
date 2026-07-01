// Event-commit durability tracking: the scheduler records in-flight
// user-intent event-handler commits so the client-facing quiescence
// (Scheduler.idleWithEventCommits, reached via RuntimeProcessor.handleIdle)
// waits for them to settle. Without this a just-issued event write whose commit
// is still in flight is dropped when the page (and its worker) is torn down on
// navigate/reload before the commit reaches the server. Plain idle() — reactive
// quiescence used by internal callers — deliberately does not wait for them.
import {
  afterEach,
  assertSpyCalls,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
  spy,
} from "./scheduler-test-utils.ts";
import type {
  EventHandler,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("scheduler event-commit durability tracking", () => {
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

  it("plain idle() ignores a pending commit; idleWithEventCommits waits for it", async () => {
    const scheduler = runtime.scheduler;
    expect(scheduler.hasPendingEventCommits()).toBe(false);

    const { promise, resolve } = Promise.withResolvers<void>();
    scheduler.trackEventCommit(promise);
    expect(scheduler.hasPendingEventCommits()).toBe(true);

    // Reactive quiescence only: plain idle() returns despite the in-flight
    // commit (this is what internal callers rely on).
    await scheduler.idle();
    expect(scheduler.hasPendingEventCommits()).toBe(true);

    // The client-facing wait does not resolve until the commit settles.
    let settled = false;
    const idleP = scheduler.idleWithEventCommits().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(scheduler.hasPendingEventCommits()).toBe(true);

    resolve();
    await idleP;
    expect(settled).toBe(true);
    expect(scheduler.hasPendingEventCommits()).toBe(false);
  });

  it("converges when called while the scheduler is busy (parked waiter)", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "commit-durability-parked-in",
      undefined,
      tx,
    );
    eventCell.set(0);
    const resultCell = runtime.getCell<number>(
      space,
      "commit-durability-parked-out",
      undefined,
      tx,
    );
    resultCell.set(0);
    tx.commit();

    const handler: EventHandler = (handlerTx, event) => {
      resultCell.withTx(handlerTx).send(event);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    // Queue the event and immediately wait: the scheduler is still scheduled to
    // run, so the waiter parks in idlePromises. It must converge, not spin the
    // drain (a synchronous re-check would re-enter idlePromises mid-drain).
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 9);
    await Promise.race([
      runtime.scheduler.idleWithEventCommits(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("idleWithEventCommits hung")), 5000)
      ),
    ]);
    expect(runtime.scheduler.hasPendingEventCommits()).toBe(false);
    expect(resultCell.get()).toBe(9);
  });

  it("converges when parked during non-committing work (no pending commit)", async () => {
    // A handler that writes nothing produces no tracked commit. Queuing it and
    // waiting immediately parks the waiter while the scheduler is scheduled with
    // NO pending commit — the path where a synchronous re-check would re-enter
    // idlePromises during the drain and spin.
    const eventCell = runtime.getCell<number>(
      space,
      "commit-durability-parked-nowrite",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    const handler: EventHandler = () => {};
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await Promise.race([
      runtime.scheduler.idleWithEventCommits(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("idleWithEventCommits hung")), 5000)
      ),
    ]);
    expect(runtime.scheduler.hasPendingEventCommits()).toBe(false);
  });

  it("idleWithEventCommits settles even if a commit rejects", async () => {
    const scheduler = runtime.scheduler;
    const { promise, reject } = Promise.withResolvers<void>();
    scheduler.trackEventCommit(promise);
    expect(scheduler.hasPendingEventCommits()).toBe(true);

    reject(new Error("commit failed"));
    // The tracked promise is normalized to always resolve, so a rejection never
    // escapes and never wedges the wait.
    await scheduler.idleWithEventCommits();
    expect(scheduler.hasPendingEventCommits()).toBe(false);
  });

  it("registers the commit of an event that changed a value", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "commit-durability-event-in",
      undefined,
      tx,
    );
    eventCell.set(0);
    const resultCell = runtime.getCell<number>(
      space,
      "commit-durability-event-out",
      undefined,
      tx,
    );
    resultCell.set(0);
    tx.commit();

    const handler: EventHandler = (handlerTx, event) => {
      resultCell.withTx(handlerTx).send(event);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    const trackSpy = spy(runtime.scheduler, "trackEventCommit");
    try {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 5);
      await runtime.idle();
      // The write changed a value, so its commit is registered for the
      // client-facing idle to await.
      assertSpyCalls(trackSpy, 1);
    } finally {
      trackSpy.restore();
    }
  });

  it("does not register a commit for an event that changed nothing", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "commit-durability-noop-in",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    // Handler that writes nothing: no changed writes, nothing durable to lose.
    const handler: EventHandler = () => {};
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    const trackSpy = spy(runtime.scheduler, "trackEventCommit");
    try {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
      await runtime.idle();
      assertSpyCalls(trackSpy, 0);
    } finally {
      trackSpy.restore();
    }
  });
});
