import type { Action } from "../src/scheduler.ts";
import { buildSchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  benchOptions,
  benchSpace,
  cleanupSchedulerBenchEnv,
  consumeNumber,
  createSchedulerBenchEnv,
  runWithSchedulerTiming,
} from "./scheduler-bench-helpers.ts";

const ACTION_COUNTS = [100, 1000] as const;

const sourceAddress = (index: number): IMemorySpaceAddress => ({
  space: benchSpace,
  scope: "space",
  id: `scheduler-persistent-source:${index}`,
  path: ["value"],
});

const createAction = (index: number): Action =>
  Object.assign((_tx: unknown) => {}, {
    src: `scheduler-persistent-action:${index}`,
  }) as Action;

const createObservation = (index: number) =>
  buildSchedulerActionObservation({
    actionId: `scheduler-persistent-action:${index}`,
    actionKind: "computation",
    branch: "",
    pieceId: "scheduler-persistent-piece",
    processGeneration: 1,
    implementationFingerprint: `impl:${index}`,
    runtimeFingerprint: "runtime:bench",
    observedAtSeq: 1,
    transactionKind: "action-run",
    transactionLog: {
      reads: [sourceAddress(index)],
      shallowReads: [],
      writes: [],
    },
  });

for (const actionCount of ACTION_COUNTS) {
  Deno.bench(
    `Scheduler persistent state - clean rehydrate ${actionCount} actions`,
    benchOptions(
      "scheduler-persistent-state",
      actionCount === ACTION_COUNTS[0],
    ),
    async () => {
      await runWithSchedulerTiming(
        `persistent clean rehydrate: ${actionCount} actions`,
        async (resetMeasuredTiming) => {
          const env = createSchedulerBenchEnv();
          const actions = Array.from(
            { length: actionCount },
            (_, index) => createAction(index),
          );
          for (const action of actions) {
            env.runtime.scheduler.subscribe(action, {
              reads: [],
              shallowReads: [],
              writes: [],
            });
          }

          resetMeasuredTiming();
          for (const [index, action] of actions.entries()) {
            env.runtime.scheduler.rehydrateActionFromObservation(action, {
              observation: createObservation(index),
            });
          }

          consumeNumber(env.runtime.scheduler.getStats().pending);
          await cleanupSchedulerBenchEnv(env);
        },
      );
    },
  );

  Deno.bench(
    `Scheduler persistent state - targeted dirty rehydrate ${actionCount} actions`,
    benchOptions("scheduler-persistent-state"),
    async () => {
      await runWithSchedulerTiming(
        `persistent targeted dirty rehydrate: ${actionCount} actions`,
        async (resetMeasuredTiming) => {
          const env = createSchedulerBenchEnv();
          const actions = Array.from(
            { length: actionCount },
            (_, index) => createAction(index),
          );
          for (const action of actions) {
            env.runtime.scheduler.subscribe(action, {
              reads: [],
              shallowReads: [],
              writes: [],
            });
          }

          resetMeasuredTiming();
          for (const [index, action] of actions.entries()) {
            env.runtime.scheduler.rehydrateActionFromObservation(action, {
              observation: createObservation(index),
              ...(index === 0 ? { directDirtySeq: 2 } : {}),
            });
          }

          consumeNumber(env.runtime.scheduler.getStats().pending);
          await cleanupSchedulerBenchEnv(env);
        },
      );
    },
  );
}
