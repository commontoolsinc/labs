import {
  createSchedulerTestRuntime as createBaseSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  IMemorySpaceAddress,
  TransactionReactivityLog,
} from "../src/storage/interface.ts";
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
import type { RuntimeProgram } from "../src/harness/types.ts";
import type {
  Action,
  Cell,
  IExtendedStorageTransaction,
  Runtime,
} from "./scheduler-test-utils.ts";
import type { SchedulerActionSnapshotResult } from "@commonfabric/memory/v2";

// Source-backed `value -> doubled` pattern for the clean-restart resume test. A
// fresh runtime resuming from storage must resolve the piece's pattern by its
// content identity, which requires a compiled source closure — a hand-built
// pattern only gets a keyless, session-only identity (unrecoverable on reload).
const CLEAN_RESTART_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  const doubled = computed(() => value * 2);",
      "  return { doubled };",
      "});",
    ].join("\n"),
  }],
};

const DIRECT_OUTPUT_WITH_SIDE_WRITE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, Writable } from 'commonfabric';",
      "export default pattern(() => {",
      "  const source = new Writable<number>(2);",
      "  const side = new Writable<number>(0);",
      "  computed(() => side.set(source.get() * 3));",
      "  return { source, side };",
      "});",
    ].join("\n"),
  }],
};

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

const actualOnlyWriteAddress = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:dynamic-target" as const,
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
): ReadonlyMap<string, readonly PersistedSchedulerObservationSnapshot[]> => {
  const result = new Map<string, PersistedSchedulerObservationSnapshot[]>();
  for (const snapshot of snapshots) {
    const candidates = result.get(snapshot.observation.actionId) ?? [];
    candidates.push({
      executionContextKey: snapshot.executionContextKey,
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
    });
    result.set(snapshot.observation.actionId, candidates);
  }
  return result;
};

const currentSnapshotOracle = {
  addressesCurrentAtOrBelow: () => true,
  hasPendingWriteOverlapping: () => false,
};

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

  it("binds complete structural summaries to observation fingerprints", () => {
    const summaryReads = [{ ...readAddress, path: [...readAddress.path] }];
    const observation = buildSchedulerActionObservation({
      ownerSpace: "did:key:space",
      actionId: "pattern.tsx:computed:complete",
      actionKind: "computation",
      branch: "",
      pieceId: "space:of:piece",
      processGeneration: 0,
      implementationFingerprint: "impl:complete",
      runtimeFingerprint: "runtime:complete",
      observedAtSeq: 7,
      transactionKind: "action-run",
      transactionLog: {
        reads: [readAddress],
        shallowReads: [],
        writes: [writeAddress],
        attemptedWrites: [],
      },
      currentKnownWrites: [writeAddress],
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        piece: {
          space: "did:key:space",
          scope: "space",
          id: "of:piece",
          path: ["value"],
        },
        reads: summaryReads,
        writes: [writeAddress],
        materializerWriteEnvelopes: [materializerEnvelope],
        directOutputs: [writeAddress],
      },
    });

    expect(observation.completeActionScopeSummary).toMatchObject({
      version: 1,
      complete: true,
      implementationFingerprint: "impl:complete",
      runtimeFingerprint: "runtime:complete",
      reads: [readAddress],
    });
    summaryReads[0]!.path.push("mutated-after-build");
    expect(observation.completeActionScopeSummary?.reads).toEqual([
      readAddress,
    ]);
    expect(isSchedulerActionObservation(observation)).toBe(true);
    expect(isSchedulerActionObservation({
      ...observation,
      completeActionScopeSummary: {
        ...observation.completeActionScopeSummary!,
        runtimeFingerprint: "runtime:forged",
      },
    })).toBe(false);
  });

  it("suppresses complete summaries for fallback action fingerprints", () => {
    const observation = buildSchedulerActionObservation({
      ownerSpace: "did:key:space",
      actionId: "unverified-action",
      actionKind: "computation",
      branch: "",
      pieceId: "space:of:piece",
      processGeneration: 0,
      implementationFingerprint: "action:piece:unverified-action",
      runtimeFingerprint: schedulerRuntimeFingerprint(),
      observedAtSeq: 1,
      transactionKind: "action-run",
      transactionLog: {
        reads: [],
        shallowReads: [],
        writes: [],
        attemptedWrites: [],
      },
      currentKnownWrites: [],
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        piece: {
          space: "did:key:space",
          scope: "space",
          id: "of:piece",
          path: ["value"],
        },
        reads: [],
        writes: [],
        materializerWriteEnvelopes: [],
        directOutputs: [],
      },
    });

    expect(observation.completeActionScopeSummary).toBeUndefined();
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
      currentKnownWrites: [],
      transactionLog: {
        reads: [],
        shallowReads: [],
        writes: [],
        attemptedWrites: [],
      } satisfies TransactionReactivityLog,
    });

    for (
      const key of [
        "actionKind",
        "transactionKind",
        "status",
        "currentKnownWrites",
      ] as const
    ) {
      const candidate = { ...observation } as Partial<
        SchedulerActionObservation
      >;
      delete candidate[key];
      expect(isSchedulerActionObservation(candidate)).toBe(false);
    }

    expect(isSchedulerActionObservation({
      ...observation,
      reads: [{ ...readAddress, path: [42] }],
    })).toBe(false);
    expect(isSchedulerActionObservation({
      ...observation,
      currentKnownWrites: [{ ...writeAddress, scope: "invalid" }],
    })).toBe(false);
    expect(isSchedulerActionObservation({
      ...observation,
      actionOptions: { throttleMs: Number.NaN },
    })).toBe(false);
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
          executionContextKey: "session:test:test",
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
            currentKnownWrites: [writeAddress],
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
          // Content-addressed identity (replaces the legacy `.src` key — the
          // fingerprint keys on this, never on the source location).
          implementationHash: "cf:module/test-cw:changingWriter",
          writes: [
            firstTarget.getAsNormalizedFullLink(),
            secondTarget.getAsNormalizedFullLink(),
          ],
        },
      ) as Action;

      // Observations persist only for doc-keyed registrations (per-doc
      // rehydration §2), so carry the identity a real piece registration has.
      runtime.scheduler.subscribe(changingWriter, {
        reads: [toMemorySpaceAddress(selector.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: "space:test:changing-writer",
          processGeneration: 0,
        },
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
        implementationHash: "cf:module/test-cw:changingWriter",
        writes: [
          firstTarget.getAsNormalizedFullLink(),
          secondTarget.getAsNormalizedFullLink(),
        ],
      });
      expect(
        runtime.scheduler.rehydrateActionFromObservation(
          restoredChangingWriter,
          {
            executionContextKey: "session:test:test",
            observation: changedObservation!,
          },
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
      const logSurfaceWriter = Object.assign(
        function logSurfaceWriter(actionTx: IExtendedStorageTransaction) {
          runs++;
          source.withTx(actionTx).get();
          target.withTx(actionTx).set(runs);
        },
        { implementationHash: "cf:module/test-lsw:logSurfaceWriter" },
      ) as Action;

      // Observations persist only for doc-keyed registrations (per-doc
      // rehydration §2), so carry the identity a real piece registration has.
      runtime.scheduler.subscribe(logSurfaceWriter, {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: surface,
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: "space:test:log-surface-writer",
          processGeneration: 0,
        },
      });

      await runtime.scheduler.run(logSurfaceWriter);
      expect(observations.at(-1)?.currentKnownWrites).toEqual(surface);

      const restoredWriter = Object.assign((() => {}) as Action, {
        implementationHash: "cf:module/test-lsw:logSurfaceWriter",
      });
      expect(
        runtime.scheduler.rehydrateActionFromObservation(
          restoredWriter,
          {
            executionContextKey: "session:test:test",
            observation: observations.at(-1)!,
          },
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
          executionContextKey: "session:test:test",
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
            currentKnownWrites: [],
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
          executionContextKey: "session:test:test",
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
            currentKnownWrites: [],
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

  it("selects a matching preloaded candidate instead of the first row", async () => {
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
        ownerSpace: space,
        actionId,
        actionKind: "effect",
        branch: "",
        pieceId: "space:preloaded-process",
        processGeneration: 1,
        implementationFingerprint: schedulerImplementationFingerprint(
          preloadedPersistedAction,
          actionId,
          undefined,
        ),
        runtimeFingerprint: schedulerRuntimeFingerprint(),
        observedAtSeq: 5,
        transactionKind: "action-run",
        currentKnownWrites: [writeAddress],
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
        isEffect: true,
        rehydrateFromStorage: {
          space,
          pieceId: "space:preloaded-process",
          processGeneration: 1,
          ...currentSnapshotOracle,
          snapshotsByActionId: new Map([[
            actionId,
            [{
              executionContextKey: "session:did%3Akey%3Aalice:session-one",
              observation: {
                ...observation,
                implementationFingerprint: "impl:older-candidate",
              },
            }, {
              executionContextKey: "session:did%3Akey%3Aalice:session-one",
              observation,
            }],
          ]]),
        },
      });

      await testRuntime.runtime.idle();

      expect(runs).toBe(0);
      expect(queryCount).toBe(0);
      expect(testRuntime.runtime.scheduler.isDirty(preloadedPersistedAction))
        .toBe(false);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("accepts a certified cross-space PerUser candidate", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      let runs = 0;
      const action = Object.assign(
        function crossSpaceUserCandidate() {
          runs++;
        },
        {
          writes: [writeLink],
          implementationHash: "cf:module/test:cross-space-user",
        },
      );
      const actionId = "cf:module/test:cross-space-user";
      const crossSpaceUserRead = {
        ...readAddress,
        space: "did:key:other-space" as const,
        scope: "user" as const,
      };
      const observation = buildSchedulerActionObservation({
        ownerSpace: space,
        actionId,
        actionKind: "effect",
        branch: "",
        pieceId: "space:of:cross-space-user-process",
        processGeneration: 1,
        implementationFingerprint: schedulerImplementationFingerprint(
          action,
          actionId,
          undefined,
        ),
        runtimeFingerprint: schedulerRuntimeFingerprint(),
        observedAtSeq: 5,
        transactionKind: "action-run",
        currentKnownWrites: [writeAddress],
        transactionLog: {
          reads: [crossSpaceUserRead],
          shallowReads: [],
          writes: [],
        },
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          piece: {
            space,
            scope: "space",
            id: "of:cross-space-user-process",
            path: [],
          },
          reads: [crossSpaceUserRead],
          writes: [writeAddress],
          materializerWriteEnvelopes: [],
          directOutputs: [writeAddress],
        },
      });
      testRuntime.runtime.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
        rehydrateFromStorage: {
          space,
          pieceId: observation.pieceId,
          processGeneration: 1,
          ...currentSnapshotOracle,
          snapshotsByActionId: new Map([[
            actionId,
            [{
              executionContextKey: "user:did%3Akey%3Aalice",
              observation,
            }],
          ]]),
        },
      });

      await testRuntime.runtime.idle();
      expect(runs).toBe(0);
      expect(testRuntime.runtime.scheduler.isDirty(action)).toBe(false);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("rejects a fallback-fingerprint shared candidate and runs fresh", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      let runs = 0;
      const action = Object.assign(
        function unprovedSharedCandidate() {
          runs++;
        },
        { writes: [writeLink] },
      );
      const actionId = "unprovedSharedCandidate";
      const observation = buildSchedulerActionObservation({
        ownerSpace: space,
        actionId,
        actionKind: "effect",
        branch: "",
        pieceId: "space:of:unproved-shared-process",
        processGeneration: 1,
        implementationFingerprint: schedulerImplementationFingerprint(
          action,
          actionId,
          undefined,
        ),
        runtimeFingerprint: schedulerRuntimeFingerprint(),
        observedAtSeq: 5,
        transactionKind: "action-run",
        currentKnownWrites: [writeAddress],
        transactionLog: {
          reads: [readAddress],
          shallowReads: [],
          writes: [],
        },
      });
      const forgedObservation: SchedulerActionObservation = {
        ...observation,
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          implementationFingerprint: observation.implementationFingerprint,
          runtimeFingerprint: observation.runtimeFingerprint,
          piece: {
            space,
            scope: "space",
            id: "of:unproved-shared-process",
            path: [],
          },
          reads: [readAddress],
          writes: [writeAddress],
          materializerWriteEnvelopes: [],
          directOutputs: [writeAddress],
        },
      };

      testRuntime.runtime.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
        rehydrateFromStorage: {
          space,
          pieceId: observation.pieceId,
          processGeneration: 1,
          ...currentSnapshotOracle,
          snapshotsByActionId: new Map([[
            actionId,
            [{ executionContextKey: "space", observation: forgedObservation }],
          ]]),
        },
      });

      await testRuntime.runtime.idle();
      expect(runs).toBe(1);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("does not fall back past a dirty narrower candidate", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      let runs = 0;
      const action = Object.assign(
        function dirtyNarrowerCandidate() {
          runs++;
        },
        {
          writes: [writeLink],
          implementationHash: "cf:module/test:dirty-narrower",
        },
      );
      const actionId = "dirtyNarrowerCandidate";
      const implementationFingerprint = schedulerImplementationFingerprint(
        action,
        actionId,
        undefined,
      );
      const observation = buildSchedulerActionObservation({
        ownerSpace: space,
        actionId,
        actionKind: "effect",
        branch: "",
        pieceId: "space:of:dirty-narrower-process",
        processGeneration: 1,
        implementationFingerprint,
        runtimeFingerprint: schedulerRuntimeFingerprint(),
        observedAtSeq: 5,
        transactionKind: "action-run",
        currentKnownWrites: [writeAddress],
        transactionLog: {
          reads: [readAddress],
          shallowReads: [],
          writes: [],
        },
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          piece: {
            space,
            scope: "space",
            id: "of:dirty-narrower-process",
            path: [],
          },
          reads: [readAddress],
          writes: [writeAddress],
          materializerWriteEnvelopes: [],
          directOutputs: [writeAddress],
        },
      });

      testRuntime.runtime.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
        rehydrateFromStorage: {
          space,
          pieceId: observation.pieceId,
          processGeneration: 1,
          ...currentSnapshotOracle,
          snapshotsByActionId: new Map([[
            actionId,
            [{ executionContextKey: "space", observation }, {
              executionContextKey: "session:did%3Akey%3Aalice:session-narrow",
              observation,
              directDirtySeq: 7,
            }],
          ]]),
        },
      });

      await testRuntime.runtime.idle();
      expect(runs).toBe(1);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("runs an always-run action on resume despite a matching snapshot", async () => {
    // Child-starting coordinators (map/filter/flatMap) declare resumeMode
    // "always-run": rehydrating them clean would skip the reconcile that
    // re-attaches their per-element children (per-doc-rehydration.md §3.3).
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const makeEffect = (name: string) => {
        let runs = 0;
        // Named-function trick: the property name becomes fn.name, which is
        // the action id for hash-less actions.
        const action = Object.assign(
          {
            [name]: function () {
              runs++;
            },
          }[name] as Action,
          { writes: [writeLink] },
        );
        const observation = buildSchedulerActionObservation({
          ownerSpace: space,
          actionId: name,
          actionKind: "effect",
          branch: "",
          pieceId: "space:always-run-process",
          processGeneration: 1,
          implementationFingerprint: schedulerImplementationFingerprint(
            action,
            name,
            undefined,
          ),
          runtimeFingerprint: schedulerRuntimeFingerprint(),
          observedAtSeq: 5,
          transactionKind: "action-run",
          currentKnownWrites: [writeAddress],
          transactionLog: {
            reads: [readAddress],
            shallowReads: [],
            writes: [],
          },
        });
        return { action, observation, runs: () => runs };
      };

      const control = makeEffect("rehydratedEffect");
      const coordinator = makeEffect("alwaysRunCoordinator");

      const subscribeOptions = (
        entry: ReturnType<typeof makeEffect>,
        name: string,
        resumeMode?: "always-run",
      ) => ({
        isEffect: true,
        ...(resumeMode ? { resumeMode } : {}),
        rehydrateFromStorage: {
          space,
          pieceId: "space:always-run-process",
          processGeneration: 1,
          ...currentSnapshotOracle,
          snapshotsByActionId: new Map([[
            name,
            [{
              executionContextKey:
                "session:did%3Akey%3Aalice:always-run-session" as const,
              observation: entry.observation,
            }],
          ]]),
        },
      });

      testRuntime.runtime.scheduler.subscribe(control.action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, subscribeOptions(control, "rehydratedEffect"));
      testRuntime.runtime.scheduler.subscribe(coordinator.action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, subscribeOptions(coordinator, "alwaysRunCoordinator", "always-run"));

      await testRuntime.runtime.idle();

      // Identical setups; the only difference is resumeMode. The control
      // rehydrates clean and must not run; always-run must run anyway.
      expect(control.runs()).toBe(0);
      expect(coordinator.runs()).toBe(1);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("live adoption refuses always-run coordinators (would strand new rows)", async () => {
    // Live adoption twin of the reload guard above. A map/filter/flatMap
    // coordinator declares resumeMode "always-run" because its reconcile is
    // what (re)registers per-element children. Adopting it clean from a remote
    // observation skips that reconcile, so a remotely-appended row's child
    // action is never registered and its per-element reactivity dies. The
    // guard must exclude always-run actions from adoptRemoteObservations
    // exactly as register() excludes them from snapshot-apply on resume.
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const scheduler = testRuntime.runtime.scheduler;
      const makeComputation = (name: string) => {
        // Named-function trick: fn.name is the action id for hash-less actions,
        // so the hand-built observation matches by actionId + fingerprints.
        const action = Object.assign(
          { [name]: function () {} }[name] as Action,
          { writes: [writeLink] },
        );
        const snapshot: PersistedSchedulerObservationSnapshot = {
          executionContextKey: "session:test:test",
          observation: buildSchedulerActionObservation({
            ownerSpace: space,
            actionId: name,
            actionKind: "computation",
            branch: "",
            pieceId: "space:coordinator-process",
            processGeneration: 1,
            implementationFingerprint: schedulerImplementationFingerprint(
              action,
              name,
              undefined,
            ),
            runtimeFingerprint: schedulerRuntimeFingerprint(),
            observedAtSeq: 5,
            transactionKind: "action-run",
            currentKnownWrites: [writeAddress],
            transactionLog: {
              reads: [readAddress],
              shallowReads: [],
              writes: [],
            },
          }),
        };
        return { action, snapshot };
      };

      const control = makeComputation("adoptableComputation");
      const coordinator = makeComputation("alwaysRunCoordinator");

      // Register both as live computation nodes (no isEffect → computation, so
      // both clear adoption's computation/effect gates). Only resumeMode
      // differs — the isolated variable.
      scheduler.subscribe(control.action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId: "space:coordinator-process",
          processGeneration: 1,
        },
      });
      scheduler.subscribe(coordinator.action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        resumeMode: "always-run",
        rehydrateFromStorage: {
          space,
          pieceId: "space:coordinator-process",
          processGeneration: 1,
        },
      });
      await testRuntime.runtime.idle();

      // Permissive oracle: reads current, no pending local write — so the ONLY
      // thing that can refuse adoption is the always-run guard.
      const oracle = {
        readsCurrentAtSeq: () => true,
        hasPendingLocalWriteOverlapping: () => false,
      };

      // Control adopts; the always-run coordinator is refused and must run its
      // own reconcile instead (return count excludes it).
      expect(scheduler.adoptRemoteObservations([control.snapshot], oracle))
        .toBe(1);
      expect(scheduler.adoptRemoteObservations([coordinator.snapshot], oracle))
        .toBe(0);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("matches live adoption by full durable identity and verifies outputs", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const scheduler = testRuntime.runtime.scheduler;
      const makeAction = () =>
        Object.assign(function collidingAction() {}, { writes: [writeLink] });
      const pieceOne = makeAction();
      const pieceTwo = makeAction();

      for (
        const [action, pieceId] of [
          [pieceOne, "space:piece-one"],
          [pieceTwo, "space:piece-two"],
        ] as const
      ) {
        scheduler.subscribe(action, {
          reads: [],
          shallowReads: [],
          writes: [writeAddress],
        }, {
          rehydrateFromStorage: {
            space,
            pieceId,
            processGeneration: 0,
          },
        });
      }

      const snapshot: PersistedSchedulerObservationSnapshot = {
        executionContextKey: "session:test:test",
        observation: buildSchedulerActionObservation({
          ownerSpace: space,
          branch: "",
          pieceId: "space:piece-one",
          processGeneration: 0,
          actionId: "collidingAction",
          actionKind: "computation",
          implementationFingerprint: schedulerImplementationFingerprint(
            pieceOne,
            "collidingAction",
            undefined,
          ),
          runtimeFingerprint: schedulerRuntimeFingerprint(),
          observedAtSeq: 5,
          transactionKind: "action-run",
          transactionLog: {
            reads: [readAddress],
            shallowReads: [],
            writes: [actualOnlyWriteAddress],
          },
          currentKnownWrites: [writeAddress],
        }),
      };

      let checkedAddresses: readonly IMemorySpaceAddress[] = [];
      expect(scheduler.adoptRemoteObservations([snapshot], {
        readsCurrentAtSeq: (addresses) => {
          checkedAddresses = addresses;
          return false;
        },
        hasPendingLocalWriteOverlapping: () => false,
      })).toBe(0);
      expect(
        checkedAddresses.some((address) =>
          sameSchedulerAddress(address, writeAddress)
        ),
      ).toBe(true);
      expect(
        checkedAddresses.some((address) =>
          sameSchedulerAddress(address, actualOnlyWriteAddress)
        ),
      ).toBe(true);
      expect(scheduler.isDirty(pieceOne)).toBe(true);
      expect(scheduler.isDirty(pieceTwo)).toBe(true);

      expect(scheduler.adoptRemoteObservations([snapshot], {
        readsCurrentAtSeq: () => true,
        hasPendingLocalWriteOverlapping: () => false,
      })).toBe(1);
      expect(scheduler.isDirty(pieceOne)).toBe(false);
      // Same action id and fingerprint, different piece: must remain invalid.
      expect(scheduler.isDirty(pieceTwo)).toBe(true);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("does not adopt a clean broad row past a dirty session candidate", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const scheduler = testRuntime.runtime.scheduler;
      const action = Object.assign(function adoptionContextCandidate() {}, {
        writes: [writeLink],
        implementationHash: "cf:module/test:adoption-context",
      });
      const actionId = "adoptionContextCandidate";
      const pieceId = "space:of:adoption-context-piece";
      scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        rehydrateFromStorage: {
          space,
          pieceId,
          processGeneration: 0,
        },
      });
      const observation = buildSchedulerActionObservation({
        ownerSpace: space,
        branch: "",
        pieceId,
        processGeneration: 0,
        actionId,
        actionKind: "computation",
        implementationFingerprint: schedulerImplementationFingerprint(
          action,
          actionId,
          undefined,
        ),
        runtimeFingerprint: schedulerRuntimeFingerprint(),
        observedAtSeq: 5,
        transactionKind: "action-run",
        transactionLog: {
          reads: [readAddress],
          shallowReads: [],
          writes: [],
        },
        currentKnownWrites: [writeAddress],
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          piece: {
            space,
            scope: "space",
            id: "of:adoption-context-piece",
            path: [],
          },
          reads: [readAddress],
          writes: [writeAddress],
          materializerWriteEnvelopes: [],
          directOutputs: [writeAddress],
        },
      });
      const oracle = {
        readsCurrentAtSeq: () => true,
        hasPendingLocalWriteOverlapping: () => false,
      };

      expect(scheduler.isDirty(action)).toBe(true);
      expect(scheduler.adoptRemoteObservations([{
        executionContextKey: "space",
        observation,
      }, {
        executionContextKey: "session:did%3Akey%3Aalice:adoption-session",
        observation,
        directDirtySeq: 6,
      }], oracle)).toBe(0);
      expect(scheduler.isDirty(action)).toBe(true);
    } finally {
      await disposeSchedulerTestRuntime(testRuntime);
    }
  });

  it("persists no observation for identity-less registrations", async () => {
    // Only doc-keyed observations persist: an action registered without
    // rehydration identity (session-scoped effects like sinks/pull) can never
    // be rehydrated, and a fallback pieceId would violate the doc→deriver
    // keying the per-doc restore lists by (per-doc-rehydration.md §2).
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime } = testRuntime;
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
      const identityLessEffect = Object.assign(
        function identityLessEffect() {
          runs++;
        },
        { writes: [writeLink] },
      );
      runtime.scheduler.subscribe(identityLessEffect, {
        reads: [readAddress],
        shallowReads: [],
        writes: [],
      });

      await runtime.scheduler.run(identityLessEffect);
      expect(runs).toBe(1);
      expect(observations).toEqual([]);
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
      // One StorageManager owns one authenticated session across all mounted
      // spaces, so the read-space mirror exposes the same context-qualified
      // snapshot to this manager and no other session.
      expect(readSnapshots?.snapshots.length).toBe(1);
      expect(readSnapshots?.snapshots[0]?.executionContextKey).toBe(
        ownerSnapshots?.snapshots[0]?.executionContextKey,
      );
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
        preloaded?: ReadonlyMap<
          string,
          readonly PersistedSchedulerObservationSnapshot[]
        >,
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
              ...currentSnapshotOracle,
              ...(preloaded !== undefined
                ? { snapshotsByActionId: preloaded }
                : {}),
            },
          },
        );
      const subscribeStableReader = (
        preloaded?: ReadonlyMap<
          string,
          readonly PersistedSchedulerObservationSnapshot[]
        >,
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
              ...currentSnapshotOracle,
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
          executionContextKey: "session:test:test",
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
            runtimeFingerprint: schedulerRuntimeFingerprint(),
            observedAtSeq: 1,
            transactionKind: "action-run",
            currentKnownWrites: [],
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
          executionContextKey: "session:test:test",
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
            runtimeFingerprint: schedulerRuntimeFingerprint(),
            observedAtSeq: 1,
            transactionKind: "action-run",
            currentKnownWrites: [writeAddress],
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
        runtimeFingerprint: schedulerRuntimeFingerprint(),
        observedAtSeq: 5,
        transactionKind: "action-run",
        currentKnownWrites: [],
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
          ...currentSnapshotOracle,
          snapshotsByActionId: new Map([[
            "stalePersistedAction",
            [{
              executionContextKey: "session:did%3Akey%3Aalice:stale-session",
              observation,
            }],
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
          ...currentSnapshotOracle,
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

  it("indexes a transformed computation's direct output and side write separately", async () => {
    const testRuntime = createSchedulerTestRuntime("https://example.test", {});
    try {
      const { runtime, storageManager, tx } = testRuntime;
      const compiled = await runtime.patternManager.compilePattern(
        DIRECT_OUTPUT_WITH_SIDE_WRITE_PROGRAM,
      );
      const resultCell = runtime.getCell<{ source: number; side: number }>(
        space,
        "persistent scheduler direct output with side write",
        undefined,
        tx,
      );
      const result = runtime.run(tx, compiled, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      expect(await result.pull()).toEqual({ source: 2, side: 6 });
      await runtime.storageManager.synced();

      const snapshots = await persistedSchedulerSnapshots(
        runtime,
        resultCellPieceId(resultCell),
      );
      const materializer = snapshots.find((snapshot) =>
        snapshot.observation.materializerWriteEnvelopes.length > 0
      )?.observation;
      expect(materializer).toBeDefined();
      expect(materializer?.completeActionScopeSummary?.directOutputs.length)
        .toBe(1);
      expect(materializer?.materializerWriteEnvelopes.length).toBe(1);

      const directOutput = materializer!.completeActionScopeSummary!
        .directOutputs[0];
      const sideWrite = materializer!.materializerWriteEnvelopes[0];
      expect(directOutput.id).not.toBe(sideWrite.id);

      const provider = runtime.storageManager.open(space);
      const durableWriters = await provider.writersForTargets?.({
        branch: "",
        targets: [
          { ...directOutput, space },
          { ...sideWrite, space },
        ],
      });
      expect(durableWriters).toBeDefined();
      expect(durableWriters?.writers).toHaveLength(1);
      expect(durableWriters?.writers[0]?.actionId).toBe(materializer!.actionId);
      expect(
        durableWriters?.writers[0]?.matchedWrites.map((match) => match.kind),
      )
        .toEqual(["current-known", "materializer"]);

      type SchedulerIndexServer = {
        openEngine(space: string): Promise<{
          database: {
            prepare(sql: string): {
              all(params: Record<string, unknown>): Array<{
                write_id: string;
                write_kind: string;
              }>;
            };
          };
        }>;
      };
      const server = (storageManager as unknown as {
        server(): SchedulerIndexServer;
      }).server();
      const engine = await server.openEngine(space);
      const indexedWrites = engine.database.prepare(`
        SELECT write_id, write_kind
        FROM scheduler_write_index
        WHERE action_id = :action_id
      `).all({ action_id: materializer!.actionId });

      expect(indexedWrites).toContainEqual({
        write_id: directOutput.id,
        write_kind: "current-known",
      });
      expect(indexedWrites).toContainEqual({
        write_id: sideWrite.id,
        write_kind: "materializer",
      });
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
      const compiledA = await runtimeA.patternManager.compilePattern(
        CLEAN_RESTART_PROGRAM,
      );

      const resultCellA = runtimeA.getCell<{ doubled: number }>(
        space,
        "persistent scheduler clean restart",
        undefined,
        tx,
      );
      const result = runtimeA.run(tx, compiledA, {
        value: 5,
      }, resultCellA);
      runtimeA.prepareTxForCommit(tx);
      await tx.commit();

      expect(await result.pull()).toEqual({ doubled: 10 });
      await runtimeA.storageManager.synced();
      const persisted = await persistedSchedulerSnapshots(
        runtimeA,
        resultCellPieceId(resultCellA),
      );
      const completeObservation = persisted.find((snapshot) =>
        snapshot.observation.completeActionScopeSummary !== undefined
      )?.observation;
      expect(completeObservation?.completeActionScopeSummary).toMatchObject({
        version: 1,
        complete: true,
        implementationFingerprint: completeObservation
          ?.implementationFingerprint,
        runtimeFingerprint: completeObservation?.runtimeFingerprint,
        piece: {
          space,
          scope: "space",
          id: resultCellA.getAsNormalizedFullLink().id,
          path: ["value"],
        },
      });
      expect(completeObservation?.completeActionScopeSummary?.directOutputs)
        .toHaveLength(1);
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

      // A fresh runtime resuming from storage compiles the same source so the
      // piece's pattern resolves by its content identity.
      runtimeBEnv = createSchedulerTestRuntime("https://example.test", {
        storageManager,
      });
      const runtimeB = runtimeBEnv.runtime;
      await runtimeB.patternManager.compilePattern(CLEAN_RESTART_PROGRAM);
      // Every action run appends a trace entry; a clean resume rehydrates the
      // persisted observation instead of running, so the trace stays empty.
      runtimeB.scheduler.setActionRunTraceEnabled(true);
      const resultCellB = runtimeB.getCell<{ doubled: number }>(
        space,
        "persistent scheduler clean restart",
        undefined,
      );
      await runtimeB.start(resultCellB);
      await runtimeB.idle();

      expect(resultCellB.get()).toEqual({ doubled: 10 });
      expect(runtimeB.scheduler.getActionRunTrace()).toHaveLength(0);
      expect(cellDataReads).toBe(0);

      const rehydratedAction = runtimeB.scheduler.getGraphSnapshot().nodes.find(
        (node) => node.id === completeObservation?.actionId,
      );
      expect(rehydratedAction).toMatchObject({
        id: completeObservation?.actionId,
        type: "computation",
      });
      const directOutput = completeObservation!.completeActionScopeSummary!
        .directOutputs[0];
      expect(rehydratedAction?.writes).toContain(
        `${directOutput.space}/${directOutput.id}/${
          directOutput.scope ?? "space"
        }/${directOutput.path.join("/")}`,
      );
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
