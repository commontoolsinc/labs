import { expect } from "@std/expect";
import type {
  SchedulerActionSnapshotCursor,
  SchedulerSnapshotListResult,
} from "@commonfabric/memory/v2";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, lift } from 'commonfabric';",
      "const double = lift((input: number) => input * 2);",
      "export default pattern<{ value: number }>(({ value }) => ({",
      "  doubled: double(value),",
      "}));",
    ].join("\n"),
  }],
};

const HOT_SWAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, lift } from 'commonfabric';",
      "const triple = lift((input: number) => input * 3);",
      "export default pattern<{ value: number }>(({ value }) => ({",
      "  doubled: triple(value),",
      "}));",
    ].join("\n"),
  }],
};

async function seedReloadablePiece(name: string) {
  const env = createSchedulerTestRuntime(import.meta.url, {
    experimental: { persistentSchedulerState: true },
  });
  const { runtime, tx } = env;
  const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
    space,
    tx,
  });
  const input = runtime.getCell<number>(space, `${name}-input`, undefined, tx);
  input.withTx(tx).set(5);
  const result = runtime.getCell<{ doubled: number }>(
    space,
    `${name}-result`,
    undefined,
    tx,
  );
  const handle = runtime.run(tx, compiled, { value: input }, result);
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit()).error).toBeUndefined();
  expect(await handle.pull()).toEqual({ doubled: 10 });
  await runtime.idle();
  await runtime.storageManager.synced();
  await runtime.idle();
  runtime.scheduler.dispose();
  return { env, input, result };
}

async function reloadRuntime(
  storageManager: ReturnType<
    typeof createSchedulerTestRuntime
  >["storageManager"],
) {
  const env = createSchedulerTestRuntime(import.meta.url, {
    storageManager,
    experimental: { persistentSchedulerState: true },
  });
  await env.runtime.patternManager.compilePattern(PROGRAM);
  return env;
}

type ResumeSnapshotBuckets = ReadonlyMap<
  string,
  ReadonlyMap<
    string,
    readonly {
      executionContextKey: string;
      observation: SchedulerActionObservation;
      directDirtySeq?: number;
      staleSeq?: number;
      unknownReason?: string;
    }[]
  >
>;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function runnerNumber(runner: object, property: string): number {
  const value = Reflect.get(runner, property);
  if (typeof value !== "number") {
    throw new TypeError(`Expected runner ${property} number`);
  }
  return value;
}

function runnerMap<K, V>(runner: object, property: string): Map<K, V> {
  const value = Reflect.get(runner, property);
  if (!(value instanceof Map)) {
    throw new TypeError(`Expected runner ${property} map`);
  }
  return value as Map<K, V>;
}

function runnerSet<T>(runner: object, property: string): Set<T> {
  const value = Reflect.get(runner, property);
  if (!(value instanceof Set)) {
    throw new TypeError(`Expected runner ${property} set`);
  }
  return value as Set<T>;
}

function runnerMethod<Args extends unknown[], Return>(
  runner: object,
  property: string,
): (...args: Args) => Return {
  const value = Reflect.get(runner, property);
  if (typeof value !== "function") {
    throw new TypeError(`Expected runner ${property} method`);
  }
  return value.bind(runner) as (...args: Args) => Return;
}

function setRunnerProperty(
  runner: object,
  property: string,
  value: unknown,
): void {
  if (!Reflect.set(runner, property, value)) {
    throw new TypeError(`Unable to set runner ${property}`);
  }
}

function preResolutionStopKeys(value: unknown): Set<unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new TypeError("Expected active start attempt record");
  }
  const stopKeys = Reflect.get(value, "preResolutionStopKeys");
  if (!(stopKeys instanceof Set)) {
    throw new TypeError("Expected active start attempt stop keys");
  }
  return stopKeys;
}

Deno.test("reload rejects a snapshot when an input advances after listing", async () => {
  const seeded = await seedReloadablePiece("snapshot-list-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  try {
    const { runtime } = reloaded;
    runtime.scheduler.setActionRunTraceEnabled(true);
    const provider = runtime.storageManager.open(space);
    const originalList = provider.listSchedulerActionSnapshots!.bind(provider);
    let injected = false;
    provider.listSchedulerActionSnapshots = async (query) => {
      const page = await originalList(query);
      if (!injected) {
        injected = true;
        const tx = seeded.env.runtime.edit();
        seeded.input.withTx(tx).set(7);
        expect((await tx.commit()).error).toBeUndefined();
        await seeded.env.runtime.storageManager.synced();
      }
      return page;
    };

    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;
    expect(await runtime.start(result)).toBe(true);
    const cancelSink = result.sink(() => {});
    try {
      await runtime.scheduler.idleWithPendingCommits();
      expect(result.getAsQueryResult()).toEqual({ doubled: 14 });
      expect(runtime.scheduler.getActionRunTrace().length).toBeGreaterThan(0);
    } finally {
      cancelSink();
    }
  } finally {
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("reload degrades a torn multi-page snapshot listing to fresh runs", async () => {
  const seeded = await seedReloadablePiece("snapshot-page-epoch");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  try {
    const { runtime } = reloaded;
    runtime.scheduler.setActionRunTraceEnabled(true);
    const provider = runtime.storageManager.open(space);
    let calls = 0;
    const cursor: SchedulerActionSnapshotCursor = {
      ownerSpace: space,
      pieceId: "space:synthetic",
      processGeneration: 0,
      actionId: "synthetic",
      executionContextKey: "space",
    };
    provider.listSchedulerActionSnapshots = (): Promise<
      SchedulerSnapshotListResult
    > => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? { serverSeq: 10, snapshots: [], nextCursor: cursor }
          : { serverSeq: 11, snapshots: [] },
      );
    };

    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;
    expect(await runtime.start(result)).toBe(true);
    const cancelSink = result.sink(() => {});
    try {
      await runtime.scheduler.idleWithPendingCommits();
      expect(calls).toBe(2);
      expect(result.getAsQueryResult()).toEqual({ doubled: 10 });
      expect(runtime.scheduler.getActionRunTrace().length).toBeGreaterThan(0);
    } finally {
      cancelSink();
    }
  } finally {
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("reload buckets valid snapshot metadata and ignores invalid observations", async () => {
  const seeded = await seedReloadablePiece("snapshot-bucket-metadata");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  try {
    const { runtime } = reloaded;
    const provider = runtime.storageManager.open(space);
    const originalList = provider.listSchedulerActionSnapshots!.bind(provider);
    const seededPage = await originalList({
      ownerSpace: space,
      processGeneration: 0,
    });
    const valid = seededPage.snapshots.find((snapshot) =>
      isSchedulerActionObservation(snapshot.observation)
    );
    expect(valid).toBeDefined();
    if (!valid || !isSchedulerActionObservation(valid.observation)) {
      throw new Error("seeded piece produced no scheduler observation");
    }

    provider.listSchedulerActionSnapshots = () =>
      Promise.resolve({
        serverSeq: seededPage.serverSeq,
        snapshots: [
          { ...valid, observation: { not: "a scheduler observation" } },
          {
            ...valid,
            directDirtySeq: 17,
            staleSeq: 18,
            unknownReason: "snapshot metadata fidelity",
          },
        ],
      });

    const loadResumeSnapshotsForSpace = runnerMethod<
      [string, number],
      Promise<ResumeSnapshotBuckets | undefined>
    >(runtime.runner, "loadResumeSnapshotsForSpace");
    const byPiece = await loadResumeSnapshotsForSpace(
      space,
      runnerNumber(runtime.runner, "lifecycleEpoch"),
    );
    expect(byPiece?.size).toBe(1);
    expect([...byPiece?.keys() ?? []]).toEqual([valid.observation.pieceId]);
    const bucket = byPiece?.get(valid.observation.pieceId);
    expect(bucket?.size).toBe(1);
    expect(bucket?.get(valid.observation.actionId)).toEqual([{
      executionContextKey: valid.executionContextKey,
      observation: valid.observation,
      directDirtySeq: 17,
      staleSeq: 18,
      unknownReason: "snapshot metadata fidelity",
    }]);
  } finally {
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("reload resumes fresh when the provider cannot list scheduler snapshots", async () => {
  const seeded = await seedReloadablePiece("snapshot-list-unsupported");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  const { runtime } = reloaded;
  const provider = runtime.storageManager.open(space);
  const originalList = provider.listSchedulerActionSnapshots;
  try {
    runtime.scheduler.setActionRunTraceEnabled(true);
    provider.listSchedulerActionSnapshots = undefined;
    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;

    expect(await runtime.start(result)).toBe(true);
    const cancelSink = result.sink(() => {});
    try {
      await runtime.scheduler.idleWithPendingCommits();
      expect(result.getAsQueryResult()).toEqual({ doubled: 10 });
      expect(runtime.scheduler.getActionRunTrace().length).toBeGreaterThan(0);
    } finally {
      cancelSink();
    }
  } finally {
    provider.listSchedulerActionSnapshots = originalList;
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("dispose invalidates a held snapshot listing before it can register work", async () => {
  const seeded = await seedReloadablePiece("snapshot-dispose-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  const { runtime } = reloaded;
  const provider = runtime.storageManager.open(space);
  const originalList = provider.listSchedulerActionSnapshots!.bind(provider);
  const seededPage = await originalList({
    ownerSpace: space,
    processGeneration: 0,
  });
  let resolveList!: (page: SchedulerSnapshotListResult) => void;
  let markListingStarted!: () => void;
  const listingStarted = new Promise<void>((resolve) => {
    markListingStarted = resolve;
  });
  provider.listSchedulerActionSnapshots = () => {
    markListingStarted();
    return new Promise((resolve) => {
      resolveList = resolve;
    });
  };
  const originalEdit = runtime.edit.bind(runtime);
  let editCalls = 0;
  runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
    editCalls++;
    return originalEdit(...args);
  }) as typeof runtime.edit;

  const result = runtime.getCellFromLink(
    seeded.result.getAsNormalizedFullLink(),
  ) as Cell<{ doubled: number }>;
  const start = runtime.start(result);
  await listingStarted;
  const editsBeforeDispose = editCalls;
  await runtime.dispose();
  resolveList(seededPage);
  expect(await start).toBe(false);
  expect(runtime.runner.cancels.size).toBe(0);
  // Keep a concrete post-resolution assertion so a late startCore/edit cannot
  // hide behind the returned false result.
  expect(editCalls).toBe(editsBeforeDispose);
  await reloaded.storageManager.close();
});

Deno.test("stop invalidates a held snapshot listing for that piece", async () => {
  const seeded = await seedReloadablePiece("snapshot-stop-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  try {
    const { runtime } = reloaded;
    const provider = runtime.storageManager.open(space);
    const originalList = provider.listSchedulerActionSnapshots!.bind(provider);
    const seededPage = await originalList({
      ownerSpace: space,
      processGeneration: 0,
    });
    const listingStarted = Promise.withResolvers<void>();
    const heldList = Promise.withResolvers<SchedulerSnapshotListResult>();
    provider.listSchedulerActionSnapshots = () => {
      listingStarted.resolve();
      return heldList.promise;
    };
    const originalEdit = runtime.edit.bind(runtime);
    let editCalls = 0;
    runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
      editCalls++;
      return originalEdit(...args);
    }) as typeof runtime.edit;

    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;
    const startGenerationByDoc = runnerMap<string, number>(
      runtime.runner,
      "startGenerationByDoc",
    );
    const activeStartAttemptsByDoc = runnerMap<string, Set<unknown>>(
      runtime.runner,
      "activeStartAttemptsByDoc",
    );
    const starts = [runtime.start(result), runtime.start(result)];
    await listingStarted.promise;
    expect(activeStartAttemptsByDoc.size).toBe(1);
    expect(
      [...activeStartAttemptsByDoc.values()][0]?.size,
    ).toBe(2);
    runtime.runner.stop(result);
    expect(startGenerationByDoc.size).toBe(1);
    const editsAfterStop = editCalls;
    heldList.resolve(seededPage);

    expect(await Promise.all(starts)).toEqual([false, false]);
    expect(runtime.runner.cancels.size).toBe(0);
    expect(editCalls).toBe(editsAfterStop);
    expect(startGenerationByDoc.size).toBe(0);
    expect(activeStartAttemptsByDoc.size).toBe(0);
  } finally {
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("stop invalidates a start while its root cell sync is held", async () => {
  const env = createSchedulerTestRuntime(import.meta.url, {});
  try {
    const { runtime } = env;
    const result = runtime.getCell<unknown>(space, "held-root-cell-sync");
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    result.getRaw = (() => undefined) as typeof result.getRaw;
    result.sync = (() => {
      syncStarted.resolve();
      return releaseSync.promise.then(() => result);
    }) as typeof result.sync;

    const start = runtime.start(result);
    await syncStarted.promise;
    runtime.runner.stop(result);
    releaseSync.resolve();

    expect(await start).toBe(false);
    expect(runtime.runner.cancels.size).toBe(0);
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});

Deno.test("stopping a target before link resolution invalidates the held start", async () => {
  const seeded = await seedReloadablePiece("pre-resolution-target-stop-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  try {
    const { runtime } = reloaded;
    const provider = runtime.storageManager.open(space);
    const originalList = provider.listSchedulerActionSnapshots!.bind(provider);
    let snapshotListingCalls = 0;
    provider.listSchedulerActionSnapshots = (options) => {
      snapshotListingCalls++;
      return originalList(options);
    };
    const target = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;
    const link = runtime.getCell<unknown>(
      space,
      "pre-resolution-target-stop-alias",
    );
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    const targetLink = target.getAsLink();
    let resolved = false;
    link.getRaw = (() =>
      resolved ? targetLink : undefined) as typeof link.getRaw;
    link.sync = (() => {
      syncStarted.resolve();
      return releaseSync.promise.then(() => {
        resolved = true;
        return link;
      });
    }) as typeof link.sync;

    const originalStartCore = runnerMethod<
      [Cell<unknown>, unknown?],
      void
    >(runtime.runner, "startCore");
    let startCoreCalls = 0;
    setRunnerProperty(runtime.runner, "startCore", (
      resultCell: Cell<unknown>,
      options?: unknown,
    ) => {
      startCoreCalls++;
      originalStartCore(resultCell, options);
    });
    const startGenerationByDoc = runnerMap<string, number>(
      runtime.runner,
      "startGenerationByDoc",
    );
    const activeStartAttempts = runnerSet<unknown>(
      runtime.runner,
      "activeStartAttempts",
    );

    const start = runtime.start(link);
    await syncStarted.promise;
    expect(activeStartAttempts.size).toBe(1);
    runtime.runner.stop(target);
    expect(startGenerationByDoc.size).toBe(0);
    expect(
      preResolutionStopKeys([...activeStartAttempts][0])?.size,
    ).toBe(1);
    releaseSync.resolve();

    expect(await start).toBe(false);
    expect(runtime.runner.cancels.size).toBe(0);
    expect(startCoreCalls).toBe(0);
    expect(activeStartAttempts.size).toBe(0);

    // `stop(target)` above only invalidated the unresolved attempt; target was
    // never locally running. A later explicit start must therefore take the
    // storage-resume path instead of being misclassified as a cheap local
    // restart that skips dependency sync and snapshot rehydration.
    expect(await runtime.start(target)).toBe(true);
    expect(snapshotListingCalls).toBe(1);
    expect(startCoreCalls).toBe(1);
    runtime.runner.stop(target);
  } finally {
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("stopping a link target invalidates its held start", async () => {
  const seeded = await seedReloadablePiece("snapshot-link-target-stop-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  try {
    const { runtime } = reloaded;
    const provider = runtime.storageManager.open(space);
    const originalList = provider.listSchedulerActionSnapshots!.bind(provider);
    const seededPage = await originalList({
      ownerSpace: space,
      processGeneration: 0,
    });
    const listingStarted = Promise.withResolvers<void>();
    const heldList = Promise.withResolvers<SchedulerSnapshotListResult>();
    provider.listSchedulerActionSnapshots = () => {
      listingStarted.resolve();
      return heldList.promise;
    };

    const target = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;
    const linkTx = runtime.edit();
    const link = runtime.getCell<unknown>(
      space,
      "snapshot-link-target-stop-alias",
      undefined,
      linkTx,
    );
    link.withTx(linkTx).setRaw(target.getAsLink());
    expect((await linkTx.commit()).error).toBeUndefined();

    const originalEdit = runtime.edit.bind(runtime);
    let editCalls = 0;
    runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
      editCalls++;
      return originalEdit(...args);
    }) as typeof runtime.edit;

    const startGenerationByDoc = runnerMap<string, number>(
      runtime.runner,
      "startGenerationByDoc",
    );
    const activeStartAttemptsByDoc = runnerMap<string, Set<unknown>>(
      runtime.runner,
      "activeStartAttemptsByDoc",
    );
    const start = runtime.start(link);
    await listingStarted.promise;
    expect(activeStartAttemptsByDoc.size).toBe(2);
    runtime.runner.stop(target);
    expect(startGenerationByDoc.size).toBe(1);
    const editsAfterStop = editCalls;
    heldList.resolve(seededPage);

    expect(await start).toBe(false);
    expect(runtime.runner.cancels.size).toBe(0);
    expect(editCalls).toBe(editsAfterStop);
    expect(startGenerationByDoc.size).toBe(0);
    expect(activeStartAttemptsByDoc.size).toBe(0);
  } finally {
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("completed and stopped start churn releases lifecycle state", async () => {
  const env = createSchedulerTestRuntime(import.meta.url, {});
  try {
    const { runtime, tx } = env;
    const startGenerationByDoc = runnerMap<string, number>(
      env.runtime.runner,
      "startGenerationByDoc",
    );
    const activeStartAttemptsByDoc = runnerMap<string, Set<unknown>>(
      env.runtime.runner,
      "activeStartAttemptsByDoc",
    );
    const activeStartAttempts = runnerSet<unknown>(
      env.runtime.runner,
      "activeStartAttempts",
    );
    const allCancels = runnerSet<unknown>(env.runtime.runner, "allCancels");
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const results: Cell<{ doubled: number }>[] = [];

    for (let index = 0; index < 32; index++) {
      const result = runtime.getCell<{ doubled: number }>(
        space,
        `start-lifecycle-churn-${index}`,
        undefined,
        tx,
      );
      await runtime.setup(tx, compiled, { value: index }, result);
      results.push(result);
    }
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();

    for (const result of results) {
      expect(await runtime.start(result)).toBe(true);
      runtime.runner.stop(result);
    }

    expect(startGenerationByDoc.size).toBe(0);
    expect(activeStartAttemptsByDoc.size).toBe(0);
    expect(activeStartAttempts.size).toBe(0);
    expect(runtime.runner.cancels.size).toBe(0);
    expect(allCancels.size).toBe(0);
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});

Deno.test("stop invalidates a resume while dependency pre-sync is held", async () => {
  const seeded = await seedReloadablePiece("dependency-sync-stop-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  const releaseSync = Promise.withResolvers<void>();
  try {
    const { runtime } = reloaded;
    const syncStarted = Promise.withResolvers<void>();
    const originalSync = runnerMethod<unknown[], Promise<boolean>>(
      runtime.runner,
      "syncCellsForRunningPattern",
    );
    let calls = 0;
    setRunnerProperty(runtime.runner, "syncCellsForRunningPattern", async (
      ...args: unknown[]
    ) => {
      if (calls++ === 0) {
        syncStarted.resolve();
        await releaseSync.promise;
      }
      return await originalSync(...args);
    });

    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;
    const start = runtime.start(result);
    await syncStarted.promise;
    runtime.runner.stop(result);
    releaseSync.resolve();

    expect(await start).toBe(false);
    expect(runtime.runner.cancels.size).toBe(0);
  } finally {
    releaseSync.resolve();
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("resume restarts pattern resolution when identity changes during dependency pre-sync", async () => {
  const seeded = await seedReloadablePiece("dependency-sync-pattern-swap-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  const releaseSync = Promise.withResolvers<void>();
  try {
    const { runtime } = reloaded;
    const replacement = await runtime.patternManager.compilePattern(
      HOT_SWAP_PROGRAM,
    );
    const replacementRef = runtime.patternManager.getArtifactEntryRef(
      replacement,
    );
    expect(replacementRef).toBeDefined();
    if (!replacementRef) throw new Error("replacement pattern has no identity");

    const syncStarted = Promise.withResolvers<void>();
    const originalSync = runnerMethod<unknown[], Promise<boolean>>(
      runtime.runner,
      "syncCellsForRunningPattern",
    );
    let calls = 0;
    setRunnerProperty(runtime.runner, "syncCellsForRunningPattern", async (
      ...args: unknown[]
    ) => {
      if (calls++ === 0) {
        syncStarted.resolve();
        await releaseSync.promise;
      }
      return await originalSync(...args);
    });

    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<Record<string, number>>;
    const start = runtime.start(result);
    await syncStarted.promise;
    const swapTx = runtime.edit();
    result.withTx(swapTx).setMetaRaw("patternIdentity", replacementRef);
    expect((await swapTx.commit()).error).toBeUndefined();
    releaseSync.resolve();

    expect(await start).toBe(true);
    expect(await result.pull()).toEqual({ doubled: 15 });
    expect(calls).toBeGreaterThanOrEqual(2);
  } finally {
    releaseSync.resolve();
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("resume restarts pattern resolution when identity changes during snapshot listing", async () => {
  const seeded = await seedReloadablePiece("snapshot-pattern-swap-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  try {
    const { runtime } = reloaded;
    const replacement = await runtime.patternManager.compilePattern(
      HOT_SWAP_PROGRAM,
    );
    const replacementRef = runtime.patternManager.getArtifactEntryRef(
      replacement,
    );
    expect(replacementRef).toBeDefined();
    if (!replacementRef) throw new Error("replacement pattern has no identity");

    const provider = runtime.storageManager.open(space);
    const originalList = provider.listSchedulerActionSnapshots!.bind(provider);
    const seededPage = await originalList({
      ownerSpace: space,
      processGeneration: 0,
    });
    const listingStarted = Promise.withResolvers<void>();
    const heldList = Promise.withResolvers<SchedulerSnapshotListResult>();
    provider.listSchedulerActionSnapshots = () => {
      listingStarted.resolve();
      return heldList.promise;
    };

    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<Record<string, number>>;
    const start = runtime.start(result);
    await listingStarted.promise;

    // Change the durable pointer while start() still holds P1 and its snapshot.
    // The continuation must resolve and instantiate P2, not label stale P1 as
    // though it already were P2 (which would also defeat the later watcher).
    const swapTx = runtime.edit();
    result.withTx(swapTx).setMetaRaw("patternIdentity", replacementRef);
    expect((await swapTx.commit()).error).toBeUndefined();
    heldList.resolve(seededPage);

    expect(await start).toBe(true);
    expect(await result.pull()).toEqual({ doubled: 15 });
    await runtime.scheduler.idleWithPendingCommits();
  } finally {
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("stop invalidates a held initial pattern load", async () => {
  const seeded = await seedReloadablePiece("initial-pattern-load-stop-race");
  const reloaded = await reloadRuntime(seeded.env.storageManager);
  const heldLoad = Promise.withResolvers<
    Awaited<
      ReturnType<
        typeof reloaded.runtime.patternManager.loadPatternByIdentity
      >
    >
  >();
  try {
    const { runtime } = reloaded;
    const result = runtime.getCellFromLink(
      seeded.result.getAsNormalizedFullLink(),
    ) as Cell<{ doubled: number }>;
    await result.sync();
    const ref = result.getMetaRaw("patternIdentity") as
      | { identity: string; symbol: string }
      | undefined;
    expect(ref).toBeDefined();
    if (!ref) throw new Error("result has no pattern identity");

    const patternManager = runtime.patternManager;
    const originalArtifact = patternManager.artifactFromIdentitySync.bind(
      patternManager,
    );
    const loaded = originalArtifact(ref.identity, ref.symbol);
    expect(loaded).toBeDefined();
    const loadStarted = Promise.withResolvers<void>();
    patternManager.artifactFromIdentitySync = ((identity, symbol) =>
      identity === ref.identity && symbol === ref.symbol
        ? undefined
        : originalArtifact(
          identity,
          symbol,
        )) as typeof patternManager.artifactFromIdentitySync;
    patternManager.loadPatternByIdentity = (async (identity, symbol) => {
      if (identity === ref.identity && symbol === ref.symbol) {
        loadStarted.resolve();
        return await heldLoad.promise;
      }
      return originalArtifact(identity, symbol);
    }) as typeof patternManager.loadPatternByIdentity;

    const start = runtime.start(result);
    await loadStarted.promise;
    runtime.runner.stop(result);
    heldLoad.resolve(
      loaded as Awaited<
        ReturnType<typeof patternManager.loadPatternByIdentity>
      >,
    );

    expect(await start).toBe(false);
    expect(runtime.runner.cancels.size).toBe(0);
  } finally {
    heldLoad.resolve(undefined);
    await disposeSchedulerTestRuntime(reloaded);
  }
});

Deno.test("dispose invalidates a held pattern hot-swap load", async () => {
  const env = createSchedulerTestRuntime(import.meta.url, {});
  const { runtime, tx } = env;
  let disposed = false;
  const heldLoad = Promise.withResolvers<
    Awaited<
      ReturnType<
        typeof runtime.patternManager.loadPatternByIdentity
      >
    >
  >();
  try {
    const initial = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const replacement = await runtime.patternManager.compilePattern(
      HOT_SWAP_PROGRAM,
      { space, tx },
    );
    const input = runtime.getCell<number>(
      space,
      "hot-swap-dispose-input",
      undefined,
      tx,
    );
    input.withTx(tx).set(5);
    const result = runtime.getCell<unknown>(
      space,
      "hot-swap-dispose-result",
      undefined,
      tx,
    );
    runtime.run(tx, initial, { value: input }, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    const delayedIdentity = "delayed-hot-swap";
    const patternManager = runtime.patternManager;
    const originalArtifact = patternManager.artifactFromIdentitySync.bind(
      patternManager,
    );
    const originalLoad = patternManager.loadPatternByIdentity.bind(
      patternManager,
    );
    const loadStarted = Promise.withResolvers<void>();
    patternManager.artifactFromIdentitySync = ((identity, symbol) =>
      identity === delayedIdentity ? undefined : originalArtifact(
        identity,
        symbol,
      )) as typeof patternManager.artifactFromIdentitySync;
    patternManager.loadPatternByIdentity = (async (
      identity,
      symbol,
      targetSpace,
    ) => {
      if (identity !== delayedIdentity) {
        return await originalLoad(identity, symbol, targetSpace);
      }
      loadStarted.resolve();
      return await heldLoad.promise;
    }) as typeof patternManager.loadPatternByIdentity;

    const originalEdit = runtime.edit.bind(runtime);
    let editCalls = 0;
    runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
      editCalls++;
      return originalEdit(...args);
    }) as typeof runtime.edit;

    const swapTx = runtime.edit();
    result.withTx(swapTx).setMetaRaw("patternIdentity", {
      identity: delayedIdentity,
      symbol: "default",
    });
    expect((await swapTx.commit()).error).toBeUndefined();
    await loadStarted.promise;

    await runtime.dispose();
    disposed = true;
    const editsAfterDispose = editCalls;
    heldLoad.resolve(replacement);
    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(runtime.runner.cancels.size).toBe(0);
    expect(editCalls).toBe(editsAfterDispose);
  } finally {
    heldLoad.resolve(undefined);
    if (!disposed) await runtime.dispose();
    await env.storageManager.close();
  }
});

Deno.test("a locally stopped piece restarts fresh while retaining persistence identity", async () => {
  const env = createSchedulerTestRuntime(import.meta.url, {
    experimental: { persistentSchedulerState: true },
  });
  try {
    const { runtime, tx } = env;
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const input = runtime.getCell<number>(
      space,
      "local-restart-input",
      undefined,
      tx,
    );
    input.withTx(tx).set(5);
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "local-restart-result",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, { value: input }, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    expect(await handle.pull()).toEqual({ doubled: 10 });
    await runtime.scheduler.idleWithPendingCommits();

    runtime.runner.stop(result);
    const observations: SchedulerActionObservation[] = [];
    const originalEdit = runtime.edit.bind(runtime);
    runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
      const actionTx = originalEdit(...args);
      const originalSet = actionTx.setSchedulerObservation?.bind(actionTx);
      actionTx.setSchedulerObservation = (value: unknown) => {
        if (isSchedulerActionObservation(value)) observations.push(value);
        originalSet?.(value);
      };
      return actionTx;
    }) as typeof runtime.edit;

    const update = runtime.edit();
    input.withTx(update).set(7);
    expect((await update.commit()).error).toBeUndefined();
    expect(await runtime.start(result)).toBe(true);
    const cancelSink = result.sink(() => {});
    try {
      await runtime.scheduler.idleWithPendingCommits();
      expect(result.getAsQueryResult()).toEqual({ doubled: 14 });
      expect(observations.length).toBeGreaterThan(0);
      const link = result.getAsNormalizedFullLink();
      expect(
        observations.every((observation) =>
          observation.ownerSpace === link.space &&
          observation.pieceId === `${link.scope}:${link.id}`
        ),
      ).toBe(true);
    } finally {
      cancelSink();
    }
  } finally {
    await env.runtime.dispose();
    await env.storageManager.close();
  }
});
