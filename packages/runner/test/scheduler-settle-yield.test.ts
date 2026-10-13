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
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { CooperativeYield } from "../src/scheduler/cooperative-yield.ts";

describe("scheduler", () => {
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

  /**
   * Subscribes `count` effects, each reading a cell of its own, so one
   * settle iteration runs them in registration order. `onRun` is called
   * with the index of each effect as it runs.
   */
  const subscribeEffects = (
    count: number,
    onRun: (index: number) => void,
  ): void => {
    for (let index = 0; index < count; index++) {
      const cell = runtime.getCell<number>(
        space,
        `settle yield ${index}`,
        undefined,
        tx,
      );
      cell.set(index);
      const effect: Action = (tx) => {
        onRun(index);
        cell.withTx(tx).get();
      };
      runtime.scheduler.subscribe(effect, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
    }
    tx.commit();
    tx = runtime.edit();
  };

  it("yields to the event loop between the actions of a settle once its slice is spent", async () => {
    // A slice of zero is spent before every action, so the settle yields
    // between each pair of actions it runs.
    const yielder = new CooperativeYield(0);
    runtime.scheduler.accessForTestingOnly.cooperativeYield = yielder;
    // A timer the first action arms fires on the next macrotask turn:
    // before the last action runs if the settle yields between actions,
    // and only after the whole settle if it does not.
    let ran = 0;
    let ranWhenTimerFired = -1;
    const timer = Promise.withResolvers<void>();
    subscribeEffects(3, (index) => {
      if (index === 0) {
        setTimeout(() => {
          ranWhenTimerFired = ran;
          timer.resolve();
        }, 0);
      }
      ran += 1;
    });
    await runtime.idle();
    // `idle()` spans the yields: it resolves once the whole pass has run,
    // not at the first turn the pass hands back.
    const ranAtIdle = ran;
    await timer.promise;
    expect(ranAtIdle).toBe(3);
    expect(yielder.yieldCount).toBeGreaterThan(0);
    expect(ranWhenTimerFired).toBeGreaterThan(0);
    expect(ranWhenTimerFired).toBeLessThan(3);
  });

  it("reruns an action whose input a yield let change before `idle()` resolves", async () => {
    const yielder = new CooperativeYield(0);
    runtime.scheduler.accessForTestingOnly.cooperativeYield = yielder;
    const input = runtime.getCell<number>(
      space,
      "settle yield changed input",
      undefined,
      tx,
    );
    input.set(1);
    const seen: number[] = [];
    const reader: Action = (tx) => {
      seen.push(input.withTx(tx).get());
    };
    runtime.scheduler.subscribe(reader, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    // The reader runs first. A timer the next action arms fires in the turn
    // the settle yields before the action after it, and commits a write to
    // the reader's input while the pass is still under way.
    const written = Promise.withResolvers<void>();
    subscribeEffects(3, (index) => {
      if (index !== 0) return;
      setTimeout(() => {
        const write = runtime.edit();
        input.withTx(write).set(2);
        write.commit();
        written.resolve();
      }, 0);
    });
    await runtime.idle();
    const seenAtIdle = [...seen];
    await written.promise;
    expect(seenAtIdle).toEqual([1, 2]);
  });

  it("runs a settle whose slice is never spent without yielding", async () => {
    const yielder = new CooperativeYield(Number.POSITIVE_INFINITY);
    runtime.scheduler.accessForTestingOnly.cooperativeYield = yielder;
    let ran = 0;
    subscribeEffects(3, () => {
      ran += 1;
    });
    await runtime.idle();
    expect(ran).toBe(3);
    expect(yielder.yieldCount).toBe(0);
  });
});
