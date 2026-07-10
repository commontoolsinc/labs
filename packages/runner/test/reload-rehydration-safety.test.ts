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
    const start = runtime.start(result);
    await listingStarted.promise;
    runtime.runner.stop(result);
    const editsAfterStop = editCalls;
    heldList.resolve(seededPage);

    expect(await start).toBe(false);
    expect(runtime.runner.cancels.size).toBe(0);
    expect(editCalls).toBe(editsAfterStop);
  } finally {
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
