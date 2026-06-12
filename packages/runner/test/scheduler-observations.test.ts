import {
  createSchedulerTestRuntime as createBaseSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type { TransactionReactivityLog } from "../src/storage/interface.ts";
import {
  buildSchedulerActionObservation,
  isSchedulerActionObservation,
  type PersistedSchedulerObservationSnapshot,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import {
  schedulerImplementationFingerprint,
  schedulerRuntimeFingerprint,
} from "../src/scheduler/run.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type {
  Action,
  Cell,
  IExtendedStorageTransaction,
  Runtime,
} from "./scheduler-test-utils.ts";
import type { SchedulerActionSnapshotResult } from "@commonfabric/memory/v2";

const createSchedulerTestRuntime: typeof createBaseSchedulerTestRuntime = (
  apiUrl,
  options = {},
) =>
  createBaseSchedulerTestRuntime(apiUrl, {
    ...options,
    experimental: {
      persistentSchedulerState: true,
      ...options.experimental,
    },
  });

const readAddress = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:source" as const,
  path: ["value", "input"],
};

const shallowReadAddress = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:list" as const,
  path: ["value", "items"],
};

const writeAddress = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:target" as const,
  path: ["value", "output"],
};

const writeLink = {
  space: writeAddress.space,
  scope: writeAddress.scope,
  id: writeAddress.id,
  path: writeAddress.path.slice(1),
};

const materializerEnvelope = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:materialized" as const,
  path: ["value"],
};

type SchedulerSnapshotWithObservation =
  & SchedulerActionSnapshotResult
  & { observation: SchedulerActionObservation };

type WatchSetCounterServer = {
  evaluateWatchSet: (...args: unknown[]) => unknown;
};

const resultCellPieceId = (cell: Cell<unknown>): string => {
  const { scope, id } = cell.getAsNormalizedFullLink();
  return `${scope}:${id}`;
};

const persistedSchedulerSnapshots = async (
  runtime: Runtime,
  pieceId: string,
): Promise<SchedulerSnapshotWithObservation[]> => {
  const provider = runtime.storageManager.open(space);
  const result = await provider.listSchedulerActionSnapshots?.({
    pieceId,
    processGeneration: 0,
  });
  expect(result).toBeDefined();
  return (result?.snapshots ?? []).filter((snapshot) =>
    isSchedulerActionObservation(snapshot.observation)
  ) as SchedulerSnapshotWithObservation[];
};

const hasPersistedDirtyState = (
  snapshot: SchedulerActionSnapshotResult,
): boolean =>
  snapshot.directDirtySeq !== undefined ||
  snapshot.staleSeq !== undefined ||
  snapshot.unknownReason !== undefined;

const snapshotsByActionId = (
  snapshots: SchedulerSnapshotWithObservation[],
): ReadonlyMap<string, PersistedSchedulerObservationSnapshot> =>
  new Map(
    snapshots.map((snapshot) => [
      snapshot.observation.actionId,
      {
        observation: snapshot.observation,
        ...(snapshot.directDirtySeq !== undefined
          ? { directDirtySeq: snapshot.directDirtySeq }
          : {}),
        ...(snapshot.staleSeq !== undefined
          ? { staleSeq: snapshot.staleSeq }
          : {}),
        ...(snapshot.unknownReason !== undefined
          ? { unknownReason: snapshot.unknownReason }
          : {}),
      },
    ]),
  );

const sameSchedulerAddress = (
  left: SchedulerActionObservation["reads"][number],
  right: SchedulerActionObservation["reads"][number],
): boolean =>
  left.space === right.space &&
  left.scope === right.scope &&
  left.id === right.id &&
  JSON.stringify(left.path) === JSON.stringify(right.path);

const observationReadsAddress = (
  snapshot: SchedulerSnapshotWithObservation,
  address: SchedulerActionObservation["reads"][number],
): boolean =>
  snapshot.observation.reads.some((read) =>
    sameSchedulerAddress(read, address)
  ) ||
  snapshot.observation.shallowReads.some((read) =>
    sameSchedulerAddress(read, address)
  );

describe("persistent scheduler observations", () => {
  it("builds scheduler observations without attemptedWrites", () => {
    const transactionLog: TransactionReactivityLog = {
      reads: [readAddress],
      shallowReads: [shallowReadAddress],
      writes: [writeAddress],
      attemptedWrites: [{
        space: "did:key:space" as const,
        scope: "space",
        id: "of:attempted-only" as const,
        path: ["value", "secret"],
      }],
    };

    const observation = buildSchedulerActionObservation({
      actionId: "pattern.tsx:computed:1",
      actionKind: "computation",
      branch: "",
      pieceId: "of:piece",
      processGeneration: 3,
      implementationFingerprint: "impl:v1",
      runtimeFingerprint: "runtime:test",
      observedAtSeq: 42,
      transactionKind: "action-run",
      transactionLog,
      currentKnownWrites: [writeAddress],
      materializerWriteEnvelopes: [materializerEnvelope],
      actionOptions: {
        debounceMs: 25,
      },
    });

    expect(observation).toMatchObject(
      {
        version: 2,
        actionId: "pattern.tsx:computed:1",
        actionKind: "computation",
        observedAtSeq: 42,
        reads: [readAddress],
        shallowReads: [shallowReadAddress],
        actualChangedWrites: [writeAddress],
        currentKnownWrites: [writeAddress],
        materializerWriteEnvelopes: [materializerEnvelope],
        actionOptions: { debounceMs: 25 },
      } satisfies Partial<SchedulerActionObservation>,
    );
    expect("attemptedWrites" in observation).toBe(false);
    expect("currentKnownWrites" in observation).toBe(true);
    expect("declaredWrites" in observation).toBe(false);
    expect(isSchedulerActionObservation(observation)).toBe(true);
  });

  it("rejects persisted observations missing required scheduler metadata", () => {
    const observation = buildSchedulerActionObservation({
      actionId: "pattern.tsx:computed:1",
      actionKind: "computation",
      branch: "",
      pieceId: "of:piece",
      processGeneration: 1,
      implementationFingerprint: "impl:v1",
      runtimeFingerprint: "runtime:test",
      observedAtSeq: 42,
      transactionKind: "action-run",
      transactionLog: {
        reads: [],
        shallowReads: [],
        writes: [],
        attemptedWrites: [],
      } satisfies TransactionReactivityLog,
    });

    for (const key of ["actionKind", "transactionKind", "status"] as const) {
      const candidate = { ...observation } as Partial<
        SchedulerActionObservation
      >;
      delete candidate[key];
      expect(isSchedulerActionObservation(candidate)).toBe(false);
    }
  });

  it("rehydrates clean scheduler observations without rerun pressure", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const persistedAction = Object.assign(
        function persistedAction() {},
        { writes: [writeLink] },
      );
      testRuntime.runtime.scheduler.subscribe(persistedAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      });
      expect(testRuntime.runtime.scheduler.isDirty(persistedAction)).toBe(true);

      const rehydrated = testRuntime.runtime.scheduler
        .rehydrateActionFromObservation(persistedAction, {
          observation: buildSchedulerActionObservation({
            actionId: "persistedAction",
            actionKind: "computation",
            branch: "",
            pieceId: "of:piece",
            processGeneration: 1,
            implementationFingerprint: "impl:v1",
            runtimeFingerprint: "runtime:test",
            observedAtSeq: 5,
            transactionKind: "action-run",
            transactionLog: {
              reads: [readAddress],
              shallowReads: [],
              writes: [],
            },
          }),
        });

      expect(rehydrated).toBe(true);
      expect(testRuntime.runtime.scheduler.isDirty(persistedAction)).toBe(
        false,
      );
      expect(testRuntime.runtime.scheduler.getStats().pending).toBe(0);
      expect(testRuntime.runtime.scheduler.getMightWrite(persistedAction))
        .toEqual(
          [writeAddress],
        );
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("persists the static scheduling surface when an action write path changes", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const selector = runtime.getCell<boolean>(
        space,
        "scheduler-observation-write-selector",
        undefined,
        tx,
      );
      const firstTarget = runtime.getCell<number>(
        space,
        "scheduler-observation-first-write",
        undefined,
        tx,
      );
      const secondTarget = runtime.getCell<number>(
        space,
        "scheduler-observation-second-write",
        undefined,
        tx,
      );
      selector.set(false);
      firstTarget.set(0);
      secondTarget.set(0);
      await tx.commit();

      const observations: SchedulerActionObservation[] = [];
      const originalEdit = runtime.edit.bind(runtime);
      runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
        const actionTx = originalEdit(...args);
        const originalSetSchedulerObservation = actionTx
          .setSchedulerObservation?.bind(actionTx);
        actionTx.setSchedulerObservation = (observation: unknown) => {
          if (isSchedulerActionObservation(observation)) {
            observations.push(observation);
          }
          originalSetSchedulerObservation?.(observation);
        };
        return actionTx;
      }) as typeof runtime.edit;

      let runs = 0;
      const staticSurface = [
        toMemorySpaceAddress(firstTarget.getAsNormalizedFullLink()),
        toMemorySpaceAddress(secondTarget.getAsNormalizedFullLink()),
      ];
      const changingWriter = Object.assign(
        function changingWriter(actionTx: IExtendedStorageTransaction) {
          runs++;
          const writeSecondTarget = selector.withTx(actionTx).get();
          const target = writeSecondTarget ? secondTarget : firstTarget;
          target.withTx(actionTx).set(runs);
        },
        {
          writes: [
            firstTarget.getAsNormalizedFullLink(),
            secondTarget.getAsNormalizedFullLink(),
          ],
        },
      ) as Action;

      runtime.scheduler.subscribe(changingWriter, {
        reads: [toMemorySpaceAddress(selector.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      });

      await runtime.scheduler.run(changingWriter);
      expect(observations.at(-1)?.currentKnownWrites).toEqual(staticSurface);
      expect(observations.at(-1)?.declaredWrites).toBeUndefined();

      const triggerTx = runtime.edit();
      selector.withTx(triggerTx).set(true);
      await triggerTx.commit();

      await runtime.scheduler.run(changingWriter);
      const changedObservation = observations.at(-1);
      expect(changedObservation?.actualChangedWrites).toEqual([
        toMemorySpaceAddress(secondTarget.getAsNormalizedFullLink()),
      ]);
      expect(changedObservation?.currentKnownWrites).toEqual(staticSurface);
      expect(changedObservation?.declaredWrites).toBeUndefined();

      const restoredChangingWriter = Object.assign((() => {}) as Action, {
        writes: [
          firstTarget.getAsNormalizedFullLink(),
          secondTarget.getAsNormalizedFullLink(),
        ],
      });
      (restoredChangingWriter as { src?: string }).src = "changingWriter";
      expect(
        runtime.scheduler.rehydrateActionFromObservation(
          restoredChangingWriter,
          { observation: changedObservation! },
        ),
      ).toBe(true);
      expect(runtime.scheduler.getMightWrite(restoredChangingWriter)).toEqual(
        staticSurface,
      );
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("persists and rehydrates immediate-log write surfaces", async () => {
    // An action whose static surface came from subscribe's ReactivityLog
    // (no `.writes` annotation) must persist that live surface and restore
    // it on rehydration — otherwise a restored action reads as writing
    // nothing.
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const source = runtime.getCell<number>(
        space,
        "scheduler-observation-immediate-log-source",
        undefined,
        tx,
      );
      const target = runtime.getCell<number>(
        space,
        "scheduler-observation-immediate-log-target",
        undefined,
        tx,
      );
      source.set(0);
      target.set(0);
      await tx.commit();

      const observations: SchedulerActionObservation[] = [];
      const originalEdit = runtime.edit.bind(runtime);
      runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
        const actionTx = originalEdit(...args);
        const originalSetSchedulerObservation = actionTx
          .setSchedulerObservation?.bind(actionTx);
        actionTx.setSchedulerObservation = (observation: unknown) => {
          if (isSchedulerActionObservation(observation)) {
            observations.push(observation);
          }
          originalSetSchedulerObservation?.(observation);
        };
        return actionTx;
      }) as typeof runtime.edit;

      const surface = [
        toMemorySpaceAddress(target.getAsNormalizedFullLink()),
      ];
      let runs = 0;
      const logSurfaceWriter = function logSurfaceWriter(
        actionTx: IExtendedStorageTransaction,
      ) {
        runs++;
        source.withTx(actionTx).get();
        target.withTx(actionTx).set(runs);
      } as Action;

      runtime.scheduler.subscribe(logSurfaceWriter, {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: surface,
      });

      await runtime.scheduler.run(logSurfaceWriter);
      expect(observations.at(-1)?.currentKnownWrites).toEqual(surface);

      const restoredWriter = (() => {}) as Action;
      (restoredWriter as { src?: string }).src = "logSurfaceWriter";
      expect(
        runtime.scheduler.rehydrateActionFromObservation(
          restoredWriter,
          { observation: observations.at(-1)! },
        ),
      ).toBe(true);
      expect(runtime.scheduler.getMightWrite(restoredWriter)).toEqual(
        surface,
      );
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("rehydrates failed scheduler observations as invalid work", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const failedPersistedAction = () => {};
      testRuntime.runtime.scheduler.subscribe(failedPersistedAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      });

      const rehydrated = testRuntime.runtime.scheduler
        .rehydrateActionFromObservation(failedPersistedAction, {
          observation: buildSchedulerActionObservation({
            actionId: "failedPersistedAction",
            actionKind: "computation",
            branch: "",
            pieceId: "of:piece",
            processGeneration: 1,
            implementationFingerprint: "impl:v1",
            runtimeFingerprint: "runtime:test",
            observedAtSeq: 5,
            transactionKind: "action-run",
            transactionLog: {
              reads: [readAddress],
              shallowReads: [],
              writes: [],
            },
            status: "failed",
            errorFingerprint: "error:test",
          }),
        });

      expect(rehydrated).toBe(true);
      expect(testRuntime.runtime.scheduler.isDirty(failedPersistedAction))
        .toBe(true);
      expect(testRuntime.runtime.scheduler.getStats().pending).toBe(0);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("rehydrates dirty scheduler observations as invalid work", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const dirtyPersistedAction = () => {};
      testRuntime.runtime.scheduler.subscribe(dirtyPersistedAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      });

      const rehydrated = testRuntime.runtime.scheduler
        .rehydrateActionFromObservation(dirtyPersistedAction, {
          directDirtySeq: 7,
          observation: buildSchedulerActionObservation({
            actionId: "dirtyPersistedAction",
            actionKind: "computation",
            branch: "",
            pieceId: "of:piece",
            processGeneration: 1,
            implementationFingerprint: "impl:v1",
            runtimeFingerprint: "runtime:test",
            observedAtSeq: 5,
            transactionKind: "action-run",
            transactionLog: {
              reads: [readAddress],
              shallowReads: [],
              writes: [],
            },
          }),
        });

      expect(rehydrated).toBe(true);
      expect(testRuntime.runtime.scheduler.isDirty(dirtyPersistedAction)).toBe(
        true,
      );
      expect(testRuntime.runtime.scheduler.getStats().pending).toBe(0);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("auto-rehydrates subscribed actions from preloaded piece snapshots", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      let runs = 0;
      const preloadedPersistedAction = Object.assign(
        function preloadedPersistedAction() {
          runs++;
        },
        { writes: [writeLink] },
      );
      const actionId = "preloadedPersistedAction";
      const provider = testRuntime.runtime.storageManager.open(space) as {
        listSchedulerActionSnapshots?: (
          query?: unknown,
        ) => Promise<{
          serverSeq: number;
          snapshots: unknown[];
        }>;
      };
      let queryCount = 0;
      provider.listSchedulerActionSnapshots = () => {
        queryCount++;
        return Promise.resolve({ serverSeq: 5, snapshots: [] });
      };

      const observation = buildSchedulerActionObservation({
        actionId,
        actionKind: "computation",
        branch: "",
        pieceId: "space:preloaded-process",
        processGeneration: 1,
        implementationFingerprint: schedulerImplementationFingerprint(
          preloadedPersistedAction,
          actionId,
          undefined,
        ),
        runtimeFingerprint: schedulerRuntimeFingerprint("pull"),
        observedAtSeq: 5,
        transactionKind: "action-run",
        transactionLog: {
          reads: [readAddress],
          shallowReads: [],
          writes: [],
        },
      });

      testRuntime.runtime.scheduler.subscribe(preloadedPersistedAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: "space:preloaded-process",
          processGeneration: 1,
          snapshotsByActionId: new Map([[
            actionId,
            { observation },
          ]]),
        },
      });

      await testRuntime.runtime.idle();

      expect(runs).toBe(0);
      expect(queryCount).toBe(0);
      expect(testRuntime.runtime.scheduler.isDirty(preloadedPersistedAction))
        .toBe(false);
      expect(
        testRuntime.runtime.scheduler.getMightWrite(preloadedPersistedAction),
      )
        .toEqual([writeAddress]);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("persists no-op cross-space observations in the owner space", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const ownerSpace = space;
      const readSpace = `${space}:scheduler-cross-space-read` as typeof space;
      const readCell = runtime.getCell<number>(
        readSpace,
        "scheduler-cross-space-read-cell",
        undefined,
        tx,
      );
      readCell.set(1);
      await tx.commit();

      let runs = 0;
      const ownerNoopReader = (actionTx: IExtendedStorageTransaction) => {
        runs++;
        readCell.withTx(actionTx).get();
      };

      runtime.scheduler.subscribe(ownerNoopReader, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
        rehydrateFromStorage: {
          space: ownerSpace,
          pieceId: "space:owner-noop-process",
          processGeneration: 1,
        },
      });

      await runtime.idle();
      await runtime.storageManager.synced();
      expect(runs).toBe(1);

      const ownerProvider = runtime.storageManager.open(ownerSpace);
      const readProvider = runtime.storageManager.open(readSpace);
      const ownerSnapshots = await ownerProvider.listSchedulerActionSnapshots?.(
        {
          pieceId: "space:owner-noop-process",
          processGeneration: 1,
          actionId: "ownerNoopReader",
        },
      );
      const readSnapshots = await readProvider.listSchedulerActionSnapshots?.({
        pieceId: "space:owner-noop-process",
        processGeneration: 1,
        actionId: "ownerNoopReader",
      });

      expect(ownerSnapshots?.snapshots.length).toBe(1);
      expect(readSnapshots?.snapshots.length).toBe(1);
      expect(
        (ownerSnapshots?.snapshots[0]?.observation as
          & SchedulerActionObservation
          & { ownerSpace?: string }).ownerSpace,
      ).toBe(ownerSpace);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("reruns an inactive cross-space reader dirtied through its read-space mirror", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const ownerSpace = space;
      const readSpace =
        `${space}:scheduler-cross-space-dirty-read` as typeof space;
      const readCell = runtime.getCell<number>(
        readSpace,
        "scheduler-cross-space-dirty-cell",
        undefined,
        tx,
      );
      readCell.set(1);
      await tx.commit();

      let runs = 0;
      const inactiveCrossSpaceReader = (
        actionTx: IExtendedStorageTransaction,
      ) => {
        runs++;
        readCell.withTx(actionTx).get();
      };

      const subscribe = () =>
        runtime.scheduler.subscribe(
          inactiveCrossSpaceReader,
          {
            reads: [],
            shallowReads: [],
            writes: [],
          },
          {
            isEffect: true,
            rehydrateFromStorage: {
              space: ownerSpace,
              pieceId: "space:inactive-cross-space-process",
              processGeneration: 1,
            },
          },
        );

      const cancel = subscribe();
      await runtime.idle();
      expect(runs).toBe(1);
      cancel();

      const writeTx = runtime.edit();
      readCell.withTx(writeTx).set(2);
      await writeTx.commit();

      subscribe();
      await runtime.idle();

      expect(runs).toBe(2);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("rehydrates only the dirty nodes when an inactive piece reads another piece's computed data", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const { commonfabric } = createTrustedBuilder(runtime);
      const { lift, pattern } = commonfabric;

      const source = runtime.getCell<number>(
        space,
        "persistent scheduler producer source",
        undefined,
        tx,
      );
      source.set(1);

      const counts = {
        producer: 0,
        consumer: 0,
      };
      const producerPattern = pattern<{ source: number }>(({ source }) => {
        const generated = lift((input: number) => {
          counts.producer++;
          return input * 10;
        })(source);
        return { generated };
      });
      const consumerPattern = pattern<{ generated: number }>(
        ({ generated }) => {
          const fromGenerated = lift((input: number) => {
            counts.consumer++;
            return input + 1;
          })(generated);
          return { fromGenerated };
        },
      );

      const producerCell = runtime.getCell<{ generated: number }>(
        space,
        "persistent scheduler producer piece",
        undefined,
        tx,
      );
      const consumerCell = runtime.getCell<{ fromGenerated: number }>(
        space,
        "persistent scheduler consumer piece",
        undefined,
        tx,
      );
      const producerResult = runtime.run(tx, producerPattern, {
        source,
      }, producerCell);
      const consumerResult = runtime.run(tx, consumerPattern, {
        generated: producerResult.key("generated"),
      }, consumerCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      expect(await consumerResult.pull()).toEqual({ fromGenerated: 11 });
      expect(counts).toEqual({
        producer: 1,
        consumer: 1,
      });
      await runtime.storageManager.synced();

      const consumerPieceId = resultCellPieceId(consumerCell);
      const generatedAddress = toMemorySpaceAddress(
        producerResult.key("generated").getAsNormalizedFullLink(),
      );
      runtime.runner.stop(consumerCell);

      const updateTx = runtime.edit();
      source.withTx(updateTx).set(2);
      await updateTx.commit();
      expect(await producerResult.pull()).toEqual({ generated: 20 });
      await runtime.storageManager.synced();

      expect(counts).toEqual({
        producer: 2,
        consumer: 1,
      });

      const dirtyConsumerSnapshots = (await persistedSchedulerSnapshots(
        runtime,
        consumerPieceId,
      )).filter(hasPersistedDirtyState);
      expect(
        dirtyConsumerSnapshots.some((snapshot) =>
          observationReadsAddress(snapshot, generatedAddress)
        ),
      ).toBe(true);

      await runtime.start(consumerCell);
      await runtime.idle();

      expect(await consumerResult.pull()).toEqual({ fromGenerated: 21 });
      expect(counts).toEqual({
        producer: 2,
        consumer: 2,
      });
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("marks inactive readers dirty when another piece only changes data from an event", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const { commonfabric } = createTrustedBuilder(runtime);
      const { handler, lift, pattern } = commonfabric;

      let producerEvents = 0;
      const updateGenerated = handler<
        { value: number },
        { generated: number }
      >(({ value }, state) => {
        producerEvents++;
        state.generated = value;
      }, { proxy: true });

      const eventOnlyProducerPattern = pattern<{ generated: number }>(
        ({ generated }) => ({
          generated,
          stream: updateGenerated({ generated }),
        }),
      );

      const counts = {
        consumer: 0,
      };
      const consumerPattern = pattern<{ generated: number }>(
        ({ generated }) => {
          const fromGenerated = lift((input: number) => {
            counts.consumer++;
            return input + 1;
          })(generated);
          return { fromGenerated };
        },
      );

      const producerCell = runtime.getCell<{ generated: number; stream: any }>(
        space,
        "persistent scheduler event producer piece",
        undefined,
        tx,
      );
      const consumerCell = runtime.getCell<{ fromGenerated: number }>(
        space,
        "persistent scheduler event consumer piece",
        undefined,
        tx,
      );
      const producerResult = runtime.run(tx, eventOnlyProducerPattern, {
        generated: 1,
      }, producerCell);
      const consumerResult = runtime.run(tx, consumerPattern, {
        generated: producerResult.key("generated"),
      }, consumerCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      expect(await consumerResult.pull()).toEqual({ fromGenerated: 2 });
      expect(producerEvents).toBe(0);
      expect(counts).toEqual({ consumer: 1 });
      await runtime.storageManager.synced();

      const consumerPieceId = resultCellPieceId(consumerCell);
      const generatedAddress = toMemorySpaceAddress(
        producerResult.key("generated").getAsNormalizedFullLink(),
      );
      runtime.runner.stop(consumerCell);

      producerResult.key("stream").send({ value: 2 });
      expect(await producerResult.pull()).toMatchObject({ generated: 2 });
      await runtime.storageManager.synced();

      expect(producerEvents).toBe(1);
      expect(counts).toEqual({ consumer: 1 });

      const dirtyConsumerSnapshots = (await persistedSchedulerSnapshots(
        runtime,
        consumerPieceId,
      )).filter(hasPersistedDirtyState);
      expect(
        dirtyConsumerSnapshots.some((snapshot) =>
          observationReadsAddress(snapshot, generatedAddress)
        ),
      ).toBe(true);

      await runtime.start(consumerCell);
      await runtime.idle();

      expect(await consumerResult.pull()).toEqual({ fromGenerated: 3 });
      expect(counts).toEqual({ consumer: 2 });
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("rehydrates only newly dirty persisted actions after another piece runs", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const source = runtime.getCell<number>(
        space,
        "persistent scheduler direct producer source",
        undefined,
        tx,
      );
      const generated = runtime.getCell<number>(
        space,
        "persistent scheduler direct generated",
        undefined,
        tx,
      );
      const stable = runtime.getCell<number>(
        space,
        "persistent scheduler direct stable input",
        undefined,
        tx,
      );
      const generatedOutput = runtime.getCell<number>(
        space,
        "persistent scheduler direct generated output",
        undefined,
        tx,
      );
      const stableOutput = runtime.getCell<number>(
        space,
        "persistent scheduler direct stable output",
        undefined,
        tx,
      );
      source.set(1);
      generated.set(0);
      stable.set(5);
      generatedOutput.set(0);
      stableOutput.set(0);
      await tx.commit();

      let producerRuns = 0;
      const produceGenerated = (actionTx: IExtendedStorageTransaction) => {
        producerRuns++;
        generated.withTx(actionTx).set(source.withTx(actionTx).get() * 10);
      };

      let generatedReaderRuns = 0;
      const readGenerated = (actionTx: IExtendedStorageTransaction) => {
        generatedReaderRuns++;
        generatedOutput.withTx(actionTx).set(
          generated.withTx(actionTx).get() + 1,
        );
      };

      let stableReaderRuns = 0;
      const readStable = (actionTx: IExtendedStorageTransaction) => {
        stableReaderRuns++;
        stableOutput.withTx(actionTx).set(stable.withTx(actionTx).get() * 2);
      };

      const producerPieceId = "space:persistent-direct-producer";
      const consumerPieceId = "space:persistent-direct-consumer";
      runtime.scheduler.subscribe(produceGenerated, {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(generated.getAsNormalizedFullLink())],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: producerPieceId,
          processGeneration: 0,
        },
      });

      const subscribeGeneratedReader = (
        preloaded?: ReadonlyMap<string, PersistedSchedulerObservationSnapshot>,
      ) =>
        runtime.scheduler.subscribe(
          readGenerated,
          {
            reads: [toMemorySpaceAddress(generated.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(generatedOutput.getAsNormalizedFullLink()),
            ],
          },
          {
            isEffect: true,
            rehydrateFromStorage: {
              space,
              pieceId: consumerPieceId,
              processGeneration: 0,
              ...(preloaded !== undefined
                ? { snapshotsByActionId: preloaded }
                : {}),
            },
          },
        );
      const subscribeStableReader = (
        preloaded?: ReadonlyMap<string, PersistedSchedulerObservationSnapshot>,
      ) =>
        runtime.scheduler.subscribe(
          readStable,
          {
            reads: [toMemorySpaceAddress(stable.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(stableOutput.getAsNormalizedFullLink()),
            ],
          },
          {
            isEffect: true,
            rehydrateFromStorage: {
              space,
              pieceId: consumerPieceId,
              processGeneration: 0,
              ...(preloaded !== undefined
                ? { snapshotsByActionId: preloaded }
                : {}),
            },
          },
        );

      await runtime.scheduler.run(produceGenerated);
      const cancelGeneratedReader = subscribeGeneratedReader();
      const cancelStableReader = subscribeStableReader();
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(producerRuns).toBe(1);
      expect(generatedReaderRuns).toBe(1);
      expect(stableReaderRuns).toBe(1);
      expect(generatedOutput.get()).toBe(11);
      expect(stableOutput.get()).toBe(10);

      cancelGeneratedReader();
      cancelStableReader();

      const updateTx = runtime.edit();
      source.withTx(updateTx).set(2);
      await updateTx.commit();
      await runtime.scheduler.run(produceGenerated);
      await runtime.storageManager.synced();

      expect(producerRuns).toBe(2);
      expect(generatedReaderRuns).toBe(1);
      expect(stableReaderRuns).toBe(1);

      const persistedConsumerSnapshots = await persistedSchedulerSnapshots(
        runtime,
        consumerPieceId,
      );
      const dirtyConsumerSnapshots = persistedConsumerSnapshots.filter(
        hasPersistedDirtyState,
      );
      expect(
        dirtyConsumerSnapshots.map((snapshot) => snapshot.observation.actionId),
      ).toEqual(["readGenerated"]);

      const preloadedConsumerSnapshots = snapshotsByActionId(
        persistedConsumerSnapshots,
      );
      subscribeGeneratedReader(preloadedConsumerSnapshots);
      subscribeStableReader(preloadedConsumerSnapshots);
      await runtime.idle();

      expect(generatedReaderRuns).toBe(2);
      expect(stableReaderRuns).toBe(1);
      expect(generatedOutput.get()).toBe(21);
      expect(stableOutput.get()).toBe(10);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("persists dirty state for an inactive materializer that can eagerly write other cells", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, tx } = testRuntime;
      const source = runtime.getCell<number>(
        space,
        "persistent scheduler materializer source",
        undefined,
        tx,
      );
      const target = runtime.getCell<number>(
        space,
        "persistent scheduler materializer target",
        undefined,
        tx,
      );
      source.set(1);
      target.set(0);
      await tx.commit();

      let materializerRuns = 0;
      const eagerMaterializer = (actionTx: IExtendedStorageTransaction) => {
        materializerRuns++;
        target.withTx(actionTx).set(source.withTx(actionTx).get() * 10);
      };
      const materializer = Object.assign(eagerMaterializer, {
        materializerWriteEnvelopes: [
          toMemorySpaceAddress(target.getAsNormalizedFullLink()),
        ],
      }) as Action & {
        materializerWriteEnvelopes: SchedulerActionObservation[
          "materializerWriteEnvelopes"
        ];
      };

      let readerRuns = 0;
      const targetReader = (actionTx: IExtendedStorageTransaction) => {
        readerRuns++;
        target.withTx(actionTx).get();
      };

      const materializerPieceId = "space:persistent-eager-materializer";
      const readerPieceId = "space:persistent-materialized-reader";
      const subscribeMaterializer = () =>
        runtime.scheduler.subscribe(
          materializer,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [],
          },
          {
            rehydrateFromStorage: {
              space,
              pieceId: materializerPieceId,
              processGeneration: 0,
            },
          },
        );
      const subscribeReader = () =>
        runtime.scheduler.subscribe(
          targetReader,
          {
            reads: [toMemorySpaceAddress(target.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [],
          },
          {
            isEffect: true,
            rehydrateFromStorage: {
              space,
              pieceId: readerPieceId,
              processGeneration: 0,
            },
          },
        );

      const cancelMaterializer = subscribeMaterializer();
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(materializerRuns).toBe(1);
      expect(target.get()).toBe(10);

      const cancelReader = subscribeReader();
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(readerRuns).toBe(1);

      cancelMaterializer();
      cancelReader();

      const updateTx = runtime.edit();
      source.withTx(updateTx).set(2);
      await updateTx.commit();
      await runtime.storageManager.synced();

      const materializerDirtySnapshots = (await persistedSchedulerSnapshots(
        runtime,
        materializerPieceId,
      )).filter(hasPersistedDirtyState);
      expect(
        materializerDirtySnapshots.some((snapshot) =>
          snapshot.observation.actionId === "eagerMaterializer"
        ),
      ).toBe(true);

      subscribeMaterializer();
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(materializerRuns).toBe(2);
      expect(target.get()).toBe(20);

      const readerDirtySnapshotsAfterMaterializer =
        (await persistedSchedulerSnapshots(runtime, readerPieceId)).filter(
          hasPersistedDirtyState,
        );
      expect(
        readerDirtySnapshotsAfterMaterializer.some((snapshot) =>
          observationReadsAddress(
            snapshot,
            toMemorySpaceAddress(target.getAsNormalizedFullLink()),
          )
        ),
      ).toBe(true);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("backfills dependents when the live surface restores a no-op writer", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime } = testRuntime;
      const persistedReader = () => {};
      const persistedWriter = Object.assign(
        function persistedWriter() {},
        { writes: [writeLink] },
      );

      runtime.scheduler.subscribe(persistedReader, {
        reads: [writeAddress],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      expect(
        runtime.scheduler.rehydrateActionFromObservation(persistedReader, {
          observation: buildSchedulerActionObservation({
            actionId: "persistedReader",
            actionKind: "effect",
            branch: "",
            pieceId: "space:reader-process",
            processGeneration: 1,
            implementationFingerprint: schedulerImplementationFingerprint(
              persistedReader,
              "persistedReader",
              undefined,
            ),
            runtimeFingerprint: schedulerRuntimeFingerprint("pull"),
            observedAtSeq: 1,
            transactionKind: "action-run",
            transactionLog: {
              reads: [writeAddress],
              shallowReads: [],
              writes: [],
            },
          }),
        }),
      ).toBe(true);

      runtime.scheduler.subscribe(persistedWriter, {
        reads: [],
        shallowReads: [],
        writes: [],
      });
      expect(
        runtime.scheduler.rehydrateActionFromObservation(persistedWriter, {
          observation: buildSchedulerActionObservation({
            actionId: "persistedWriter",
            actionKind: "computation",
            branch: "",
            pieceId: "space:writer-process",
            processGeneration: 1,
            implementationFingerprint: schedulerImplementationFingerprint(
              persistedWriter,
              "persistedWriter",
              undefined,
            ),
            runtimeFingerprint: schedulerRuntimeFingerprint("pull"),
            observedAtSeq: 1,
            transactionKind: "action-run",
            transactionLog: {
              reads: [],
              shallowReads: [],
              writes: [],
            },
          }),
        }),
      ).toBe(true);

      expect(
        runtime.scheduler.getDependents(persistedWriter).has(
          persistedReader,
        ),
      ).toBe(true);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("falls back to the normal first run when fingerprints mismatch", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      let runs = 0;
      const stalePersistedAction = () => {
        runs++;
      };
      const observation = buildSchedulerActionObservation({
        actionId: "stalePersistedAction",
        actionKind: "effect",
        branch: "",
        pieceId: "space:stale-process",
        processGeneration: 1,
        implementationFingerprint: "impl:old",
        runtimeFingerprint: schedulerRuntimeFingerprint("pull"),
        observedAtSeq: 5,
        transactionKind: "action-run",
        transactionLog: {
          reads: [readAddress],
          shallowReads: [],
          writes: [],
        },
      });

      testRuntime.runtime.scheduler.subscribe(stalePersistedAction, {
        reads: [],
        shallowReads: [],
        writes: [writeAddress],
      }, {
        isEffect: true,
        rehydrateFromStorage: {
          space,
          pieceId: "space:stale-process",
          processGeneration: 1,
          snapshotsByActionId: new Map([[
            "stalePersistedAction",
            { observation },
          ]]),
        },
      });

      await testRuntime.runtime.idle();

      expect(runs).toBe(1);
      expect(testRuntime.runtime.scheduler.getMightWrite(stalePersistedAction))
        .toBeUndefined();
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("falls back to the normal first run when preloaded rehydration misses", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      let runs = 0;
      const missingPersistedAction = () => {
        runs++;
      };

      testRuntime.runtime.scheduler.subscribe(missingPersistedAction, {
        reads: [],
        shallowReads: [],
        writes: [writeAddress],
      }, {
        isEffect: true,
        rehydrateFromStorage: {
          space,
          pieceId: "space:missing-process",
          processGeneration: 1,
          snapshotsByActionId: new Map(),
        },
      });

      await testRuntime.runtime.idle();

      expect(runs).toBe(1);
      expect(testRuntime.runtime.scheduler.isDirty(missingPersistedAction))
        .toBe(false);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("resumes a clean piece without rerunning or fetching cell data", async () => {
    const runtimeAEnv = createSchedulerTestRuntime("https://example.test", {});
    let runtimeBEnv: ReturnType<typeof createSchedulerTestRuntime> | undefined;
    let restoreEvaluateWatchSet: (() => void) | undefined;
    try {
      const { runtime: runtimeA, storageManager, tx } = runtimeAEnv;
      const { commonfabric } = createTrustedBuilder(runtimeA);
      const { lift, pattern } = commonfabric;
      let runs = 0;
      const cleanRestartPattern = pattern<{ value: number }>(
        ({ value }) => {
          const doubled = lift((input: number) => {
            runs++;
            return input * 2;
          })(value);
          return { doubled };
        },
      );

      const resultCellA = runtimeA.getCell<{ doubled: number }>(
        space,
        "persistent scheduler clean restart",
        undefined,
        tx,
      );
      const result = runtimeA.run(tx, cleanRestartPattern, {
        value: 5,
      }, resultCellA);
      runtimeA.prepareTxForCommit(tx);
      await tx.commit();

      expect(await result.pull()).toEqual({ doubled: 10 });
      expect(runs).toBe(1);
      await runtimeA.storageManager.synced();
      runtimeA.scheduler.dispose();

      const server = (storageManager as unknown as {
        server(): WatchSetCounterServer;
      }).server();
      const evaluateWatchSet = server.evaluateWatchSet.bind(server);
      let cellDataReads = 0;
      server.evaluateWatchSet = (...args: unknown[]) => {
        cellDataReads++;
        return evaluateWatchSet(...args);
      };
      restoreEvaluateWatchSet = () => {
        server.evaluateWatchSet = evaluateWatchSet;
      };

      runtimeBEnv = createSchedulerTestRuntime("https://example.test", {
        storageManager,
      });
      const runtimeB = runtimeBEnv.runtime;
      runtimeB.unsafeTrustPattern(cleanRestartPattern, {
        reason: "unit test fixture",
      });
      runtimeB.patternManager.registerPattern(cleanRestartPattern);
      const resultCellB = runtimeB.getCell<{ doubled: number }>(
        space,
        "persistent scheduler clean restart",
        undefined,
      );
      await runtimeB.start(resultCellB);
      await runtimeB.idle();

      expect(resultCellB.get()).toEqual({ doubled: 10 });
      expect(runs).toBe(1);
      expect(cellDataReads).toBe(0);
    } finally {
      restoreEvaluateWatchSet?.();
      runtimeAEnv.runtime.scheduler.dispose();
      if (runtimeBEnv) {
        await disposeSchedulerTestRuntime(runtimeBEnv);
      } else {
        await disposeSchedulerTestRuntime(runtimeAEnv);
      }
    }
  });
});
