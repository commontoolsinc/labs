import {
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  space,
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

  it("rehydrates clean scheduler observations without rerun pressure", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      function persistedAction() {}
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

  it("rehydrates dirty scheduler observations as runnable work", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {
      pullMode: "enabled",
    });
    try {
      function dirtyPersistedAction() {}
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
      function storageBackedAction() {}
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
      function autoPersistedAction() {
        runs++;
      }
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
      provider.listSchedulerActionSnapshots = async (query) => {
        querySeen = query;
        return {
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
        };
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
      provider.listSchedulerActionSnapshots = async () => ({
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
      function stalePersistedAction() {
        runs++;
      }

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
      provider.listSchedulerActionSnapshots = async () => ({
        serverSeq: 5,
        snapshots: [],
      });

      let runs = 0;
      function missingPersistedAction() {
        runs++;
      }

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
