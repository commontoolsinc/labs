import {
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  getStaleSchedulerInternals,
  it,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type { TransactionReactivityLog } from "../src/storage/interface.ts";
import {
  buildSchedulerActionObservation,
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import {
  schedulerImplementationFingerprint,
  schedulerRuntimeFingerprint,
} from "../src/scheduler/action-run.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type {
  Action,
  IExtendedStorageTransaction,
} from "./scheduler-test-utils.ts";

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

const declaredWrite = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:declared" as const,
  path: ["value"],
};

const materializerEnvelope = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:materialized" as const,
  path: ["value"],
};

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
      declaredWrites: [declaredWrite],
      materializerWriteEnvelopes: [materializerEnvelope],
      actionOptions: {
        debounceMs: 25,
      },
    });

    expect(observation).toMatchObject(
      {
        version: 1,
        actionId: "pattern.tsx:computed:1",
        actionKind: "computation",
        observedAtSeq: 42,
        reads: [readAddress],
        shallowReads: [shallowReadAddress],
        actualChangedWrites: [writeAddress],
        currentKnownWrites: [writeAddress],
        declaredWrites: [declaredWrite],
        materializerWriteEnvelopes: [materializerEnvelope],
        actionOptions: { debounceMs: 25 },
      } satisfies Partial<SchedulerActionObservation>,
    );
    expect("attemptedWrites" in observation).toBe(false);
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
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const persistedAction = () => {};
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
            currentKnownWrites: [writeAddress],
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

  it("persists the post-run scheduling writes when an action write path changes", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
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
      const changingWriter: Action = (
        actionTx: IExtendedStorageTransaction,
      ) => {
        runs++;
        const writeSecondTarget = selector.withTx(actionTx).get();
        const target = writeSecondTarget ? secondTarget : firstTarget;
        target.withTx(actionTx).set(runs);
      };

      runtime.scheduler.subscribe(changingWriter, {
        reads: [toMemorySpaceAddress(selector.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      });

      await runtime.scheduler.run(changingWriter);
      expect(observations.at(-1)?.currentKnownWrites).toEqual([
        toMemorySpaceAddress(firstTarget.getAsNormalizedFullLink()),
      ]);

      const triggerTx = runtime.edit();
      selector.withTx(triggerTx).set(true);
      await triggerTx.commit();

      await runtime.scheduler.run(changingWriter);
      const changedObservation = observations.at(-1);
      expect(changedObservation?.actualChangedWrites).toEqual([
        toMemorySpaceAddress(secondTarget.getAsNormalizedFullLink()),
      ]);
      expect(changedObservation?.currentKnownWrites).toEqual([
        toMemorySpaceAddress(secondTarget.getAsNormalizedFullLink()),
      ]);

      const restoredChangingWriter: Action = () => {};
      (restoredChangingWriter as { src?: string }).src = "changingWriter";
      expect(
        runtime.scheduler.rehydrateActionFromObservation(
          restoredChangingWriter,
          { observation: changedObservation! },
        ),
      ).toBe(true);
      expect(runtime.scheduler.getMightWrite(restoredChangingWriter)).toEqual([
        toMemorySpaceAddress(secondTarget.getAsNormalizedFullLink()),
      ]);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("rehydrates dirty scheduler observations as runnable work", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
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
            currentKnownWrites: [writeAddress],
          }),
        });

      expect(rehydrated).toBe(true);
      expect(testRuntime.runtime.scheduler.isDirty(dirtyPersistedAction)).toBe(
        true,
      );
      expect(testRuntime.runtime.scheduler.getStats().pending).toBe(1);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("reports unavailable storage-backed rehydration without mutating", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const storageBackedAction = () => {};
      testRuntime.runtime.scheduler.subscribe(storageBackedAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      });

      await expect(
        testRuntime.runtime.scheduler.rehydrateActionFromStorage(
          storageBackedAction,
          space,
        ),
      ).resolves.toBe(false);
      expect(testRuntime.runtime.scheduler.isDirty(storageBackedAction)).toBe(
        true,
      );
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("auto-rehydrates subscribed actions before first execution", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      let runs = 0;
      const autoPersistedAction = () => {
        runs++;
      };
      const actionId = "autoPersistedAction";
      const provider = testRuntime.runtime.storageManager.open(space) as {
        listSchedulerActionSnapshots?: (
          query?: unknown,
        ) => Promise<{
          serverSeq: number;
          snapshots: unknown[];
        }>;
      };
      let querySeen: unknown;
      provider.listSchedulerActionSnapshots = (query) => {
        querySeen = query;
        return Promise.resolve({
          serverSeq: 5,
          snapshots: [{
            observationId: 1,
            commitSeq: null,
            observedAtSeq: 5,
            observation: buildSchedulerActionObservation({
              actionId,
              actionKind: "computation",
              branch: "",
              pieceId: "space:process",
              processGeneration: 1,
              implementationFingerprint: schedulerImplementationFingerprint(
                autoPersistedAction,
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
              currentKnownWrites: [writeAddress],
            }),
          }],
        });
      };

      testRuntime.runtime.scheduler.subscribe(autoPersistedAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: "space:process",
          processGeneration: 1,
        },
      });

      await testRuntime.runtime.idle();

      expect(runs).toBe(0);
      expect(querySeen).toMatchObject({
        actionId: "autoPersistedAction",
        pieceId: "space:process",
        processGeneration: 1,
      });
      expect(testRuntime.runtime.scheduler.isDirty(autoPersistedAction)).toBe(
        false,
      );
      expect(testRuntime.runtime.scheduler.getMightWrite(autoPersistedAction))
        .toEqual([writeAddress]);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("persists no-op cross-space observations in the owner space", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
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
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
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

  it("backfills dependents when rehydrated currentKnownWrites restore a no-op writer", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const { runtime } = testRuntime;
      const persistedReader = () => {};
      const persistedWriter = () => {};

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
            currentKnownWrites: [writeAddress],
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

  it("does not reattach an action when async initial rehydration resolves after unsubscribe", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const { runtime } = testRuntime;
      const provider = runtime.storageManager.open(space) as {
        listSchedulerActionSnapshots?: () => Promise<{
          serverSeq: number;
          snapshots: unknown[];
        }>;
      };
      let resolveSnapshots:
        | ((result: { serverSeq: number; snapshots: unknown[] }) => void)
        | undefined;
      provider.listSchedulerActionSnapshots = () =>
        new Promise((resolve) => {
          resolveSnapshots = resolve;
        });

      const canceledBeforeRehydrate = () => {};
      const cancel = runtime.scheduler.subscribe(canceledBeforeRehydrate, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: "space:canceled-process",
          processGeneration: 1,
        },
      });
      cancel();

      resolveSnapshots?.({
        serverSeq: 5,
        snapshots: [{
          observationId: 1,
          commitSeq: null,
          observedAtSeq: 5,
          observation: buildSchedulerActionObservation({
            actionId: "canceledBeforeRehydrate",
            actionKind: "computation",
            branch: "",
            pieceId: "space:canceled-process",
            processGeneration: 1,
            implementationFingerprint: schedulerImplementationFingerprint(
              canceledBeforeRehydrate,
              "canceledBeforeRehydrate",
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
            currentKnownWrites: [writeAddress],
          }),
        }],
      });
      await runtime.idle();

      expect(runtime.scheduler.getMightWrite(canceledBeforeRehydrate)).toEqual(
        [],
      );
      expect(
        runtime.scheduler.getGraphSnapshot().nodes.some((node) =>
          node.id === "canceledBeforeRehydrate"
        ),
      ).toBe(false);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("does not apply async initial rehydration after an action becomes dirty", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const { runtime } = testRuntime;
      const provider = runtime.storageManager.open(space) as {
        listSchedulerActionSnapshots?: () => Promise<{
          serverSeq: number;
          snapshots: unknown[];
        }>;
      };
      let resolveSnapshots:
        | ((result: { serverSeq: number; snapshots: unknown[] }) => void)
        | undefined;
      provider.listSchedulerActionSnapshots = () =>
        new Promise((resolve) => {
          resolveSnapshots = resolve;
        });

      const dirtyBeforeRehydrate = () => {};
      runtime.scheduler.subscribe(dirtyBeforeRehydrate, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: "space:dirty-process",
          processGeneration: 1,
        },
      });

      getStaleSchedulerInternals(runtime.scheduler).markDirty(
        dirtyBeforeRehydrate,
      );

      resolveSnapshots?.({
        serverSeq: 5,
        snapshots: [{
          observationId: 1,
          commitSeq: null,
          observedAtSeq: 5,
          observation: buildSchedulerActionObservation({
            actionId: "dirtyBeforeRehydrate",
            actionKind: "computation",
            branch: "",
            pieceId: "space:dirty-process",
            processGeneration: 1,
            implementationFingerprint: schedulerImplementationFingerprint(
              dirtyBeforeRehydrate,
              "dirtyBeforeRehydrate",
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
            currentKnownWrites: [writeAddress],
          }),
        }],
      });
      await runtime.idle();

      expect(runtime.scheduler.isDirty(dirtyBeforeRehydrate)).toBe(true);
      expect(runtime.scheduler.getMightWrite(dirtyBeforeRehydrate)).toEqual(
        [],
      );
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("falls back to the normal first run when fingerprints mismatch", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const provider = testRuntime.runtime.storageManager.open(space) as {
        listSchedulerActionSnapshots?: () => Promise<{
          serverSeq: number;
          snapshots: unknown[];
        }>;
      };
      provider.listSchedulerActionSnapshots = () =>
        Promise.resolve({
          serverSeq: 5,
          snapshots: [{
            observationId: 1,
            commitSeq: null,
            observedAtSeq: 5,
            observation: buildSchedulerActionObservation({
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
              currentKnownWrites: [writeAddress],
            }),
          }],
        });

      let runs = 0;
      const stalePersistedAction = () => {
        runs++;
      };

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
        },
      });

      await testRuntime.runtime.idle();

      expect(runs).toBe(1);
      expect(testRuntime.runtime.scheduler.getMightWrite(stalePersistedAction))
        .toEqual([writeAddress]);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("falls back to the normal first run when auto-rehydration misses", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const provider = testRuntime.runtime.storageManager.open(space) as {
        listSchedulerActionSnapshots?: () => Promise<{
          serverSeq: number;
          snapshots: unknown[];
        }>;
      };
      provider.listSchedulerActionSnapshots = () =>
        Promise.resolve({
          serverSeq: 5,
          snapshots: [],
        });

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

  it("uses persisted observations when a runner restarts a clean piece", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      const { runtime, tx } = testRuntime;
      const { commonfabric } = createTrustedBuilder(runtime);
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

      const resultCell = runtime.getCell<{ doubled: number }>(
        space,
        "persistent scheduler clean restart",
        undefined,
        tx,
      );
      const result = runtime.run(tx, cleanRestartPattern, {
        value: 5,
      }, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      expect(await result.pull()).toEqual({ doubled: 10 });
      expect(runs).toBe(1);

      runtime.runner.stop(resultCell);
      await runtime.start(resultCell);
      await runtime.idle();

      expect(resultCell.get()).toEqual({ doubled: 10 });
      expect(runs).toBe(1);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });
});
