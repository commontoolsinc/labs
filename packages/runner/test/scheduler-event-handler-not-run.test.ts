import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { EventHandler } from "../src/scheduler.ts";
import { EventHandlerNotRunError } from "../src/scheduler/backpressure.ts";
import type { IStorageNotification } from "../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

const NOT_RUN_REASON = "action argument is undefined (test)";

describe("event dispatch whose handler body did not run", () => {
  // A handler run that records `tx.dispatchedHandlerNotRun` on its
  // transaction stands for the runner's argument-did-not-resolve skip. The
  // handlers below record it themselves, so what each case pins is the
  // scheduler's disposition of the marker on a client dispatch: withdrawn
  // and re-run, never sealed as an empty commit.

  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  // Counts the commits that carry a change, so a sealed skip — an empty
  // commit — is told apart from the run that wrote.
  function countCommittedChanges(): () => number {
    let commits = 0;
    const subscription: IStorageNotification = {
      next(notification) {
        if (notification.type === "commit") {
          for (const _change of notification.changes) {
            commits++;
            break;
          }
        }
        return { done: false };
      },
    };
    env.storageManager.subscribe(subscription);
    return () => commits;
  }

  it("re-runs the handler once the marker is gone, and fires the commit callback once, on the run that wrote", async () => {
    const { runtime, tx } = env;
    const target = runtime.getCell<number>(space, "not-run-target", undefined);
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-events",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();
    const committedChanges = countCommittedChanges();

    let runs = 0;
    const handler: EventHandler = (actionTx, event: number) => {
      runs++;
      if (runs === 1) {
        actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
        return;
      }
      target.withTx(actionTx).send(event);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    const callbackStatuses: string[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      7,
      true,
      (commitTx) => {
        callbackStatuses.push(commitTx.status().status);
      },
    );
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();

    expect(runs).toBe(2);
    expect(target.get()).toBe(7);
    expect(callbackStatuses).toEqual(["done"]);
    expect(committedChanges()).toBe(1);
  });

  it("parks the re-run on a load the run's own reads registered, and dispatches when it settles", async () => {
    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(space, "not-run-cold", undefined);
    const target = runtime.getCell<string>(
      space,
      "not-run-park-target",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-park-events",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();

    // The cold document's load is in flight for as long as the test holds
    // `load` open; the storage manager reports it pending, and settles it
    // through the promise the park awaits.
    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    const load = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<readonly string[]>();
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () => [{
      space: link.space,
      scope: link.scope,
      id: link.id,
    }];
    manager.pendingLoadGeneration = (candidate) =>
      candidate === key ? 1 : undefined;
    manager.loadsSettled = (keys) => {
      parked.resolve(keys);
      return load.promise;
    };

    let runs = 0;
    const handler: EventHandler = (actionTx) => {
      runs++;
      // The read is what puts the cold document in the run's log, which is
      // what the park is keyed on.
      const value = coldDoc.withTx(actionTx).get();
      if (runs === 1) {
        actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
        return;
      }
      target.withTx(actionTx).send(`ran with ${value}`);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    let callbackRuns = 0;
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      () => {
        callbackRuns++;
      },
    );
    expect(await parked.promise).toEqual([key]);
    expect(runs).toBe(1);
    expect(callbackRuns).toBe(0);

    load.resolve();
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();
    expect(runs).toBe(2);
    expect(target.get()).toBe("ran with undefined");
    expect(callbackRuns).toBe(1);
  });

  it("fails through the error channel once the retry window is spent, with the callback seeing the aborted transaction", async () => {
    await disposeSchedulerTestRuntime(env);
    env = createSchedulerTestRuntime(import.meta.url, {
      commitBackpressure: { retryWindowMs: 20 },
    });
    const { runtime, tx } = env;
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-window-events",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();
    const committedChanges = countCommittedChanges();

    let runs = 0;
    const handler: EventHandler = (actionTx) => {
      runs++;
      actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });

    const callbackStatuses: string[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      (commitTx) => {
        callbackStatuses.push(commitTx.status().status);
      },
    );
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();

    expect(runs).toBeGreaterThanOrEqual(1);
    expect(callbackStatuses).toEqual(["error"]);
    expect(committedChanges()).toBe(0);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(error).toBeInstanceOf(EventHandlerNotRunError);
    expect((error as EventHandlerNotRunError).reason).toBe(NOT_RUN_REASON);
    expect((error as EventHandlerNotRunError).attempts).toBe(runs);
    expect(error.message).toContain(NOT_RUN_REASON);
  });

  it("drops a one-shot (`retries: false`) at once, with the callback seeing the aborted transaction", async () => {
    const { runtime, tx } = env;
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-one-shot-events",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();
    const committedChanges = countCommittedChanges();

    let runs = 0;
    const handler: EventHandler = (actionTx) => {
      runs++;
      actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    const callbackStatuses: string[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      false,
      (commitTx) => {
        callbackStatuses.push(commitTx.status().status);
      },
    );
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();

    expect(runs).toBe(1);
    expect(callbackStatuses).toEqual(["error"]);
    expect(committedChanges()).toBe(0);
  });
});
