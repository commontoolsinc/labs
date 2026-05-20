import {
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
} from "./scheduler-test-utils.ts";
import type { TransactionReactivityLog } from "../src/storage/interface.ts";
import {
  buildSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";

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
});
