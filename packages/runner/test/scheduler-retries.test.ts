// Scheduler reactive retry tests.

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
  Action,
  IExtendedStorageTransaction,
  ReactivityLog,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { watchReactiveActionCommit } from "../src/scheduler/run.ts";

describe("reactive retries", () => {
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
        { reads: [], shallowReads: [], writes: [] },
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

  // Directly exercise the reactive commit-result classification
  // (`watchReactiveActionCommit`): a whole-runtime commit injector would churn
  // every commit and re-trigger the action externally, confounding the retry
  // count, so drive the watcher with a resolved commit result instead.
  const runWatcher = async (
    errorName: string | undefined,
    initialRetries: number,
  ) => {
    const action = (() => {}) as unknown as Action;
    const retries = new WeakMap<Action, number>();
    if (initialRetries > 0) retries.set(action, initialRetries);
    let queued = 0;
    let resubscribed = 0;
    const error = errorName === undefined
      ? undefined
      : { name: errorName, message: `injected ${errorName}` };
    const commitPromise = Promise.resolve({ error }) as unknown as ReturnType<
      IExtendedStorageTransaction["commit"]
    >;
    watchReactiveActionCommit({
      action,
      tx: {} as IExtendedStorageTransaction,
      log: {} as ReactivityLog,
      retries,
      pending: new Set<Action>(),
      commitPromise,
      resubscribe: () => {
        resubscribed++;
      },
      markInvalid: () => {},
      queueExecution: () => {
        queued++;
      },
      restoreInvalidCauses: () => {},
    });
    await commitPromise;
    await new Promise((r) => setTimeout(r, 0));
    return { queued, resubscribed, retries, action };
  };

  it(
    "does not retry a terminal reactive rejection and clears the retry budget",
    async () => {
      // A deterministic commit-rule refusal (RowLabelCommitError) can never
      // converge; re-running recomputes the identical refused write and its
      // speculative rev bumps starve concurrent siblings. It must not re-queue,
      // and — since the sequence has ended — must clear any accumulated count so
      // a later input-triggered run keeps its full budget for a transient
      // failure. (Contrast the abort case above, which retries to the limit.)
      const r = await runWatcher("RowLabelCommitError", 3);
      expect(r.queued).toBe(0);
      expect(r.retries.has(r.action)).toBe(false);
    },
  );

  it(
    "does not retry a permanent reactive rejection and clears the retry budget",
    async () => {
      const r = await runWatcher("PreconditionFailedError", 3);
      expect(r.queued).toBe(0);
      expect(r.retries.has(r.action)).toBe(false);
    },
  );

  it(
    "retries a transient reactive rejection within the bounded budget",
    async () => {
      // A generic transient error keeps the bounded retry path: it re-queues and
      // charges the counter (proving terminal/permanent are the exceptions).
      const r = await runWatcher("TransactionError", 0);
      expect(r.queued).toBe(1);
      expect(r.retries.get(r.action)).toBe(1);
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
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [
            toMemorySpaceAddress(intermediate.getAsNormalizedFullLink()),
          ],
        },
        {},
      );
      runtime.scheduler.subscribe(
        action2,
        {
          reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
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
