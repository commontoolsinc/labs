import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveCommitSink,
  waveRunContextOf,
  waveSettlementOf,
} from "../src/executor/wave.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import type {
  IExtendedStorageTransaction,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";

// The four guarantees a child run carries beyond "whoever created it stops it".
// Each drives the public API only: a parent pattern, a child reached through
// it, and start/stop/abort in the order that distinguishes the cases.

const signer = await Identity.fromPassphrase("child run ownership");
const space = signer.did();

describe("child run ownership", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  // The registration key the runner indexes cancels by: the scope segment is
  // the runtime's scope INSTANCE (resolveScopeKey), not the raw scope name
  // (stage E re-keying) — entityKey is the shared constructor for the format.
  function key(cell: Cell<unknown>) {
    return entityKey(
      cell.getAsNormalizedFullLink(),
      runtime.scopeKeyIdentity,
    );
  }

  async function useServerExecutionRuntime() {
    await runtime.dispose();
    await storageManager.close();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("rolls back a nested child when its parent transaction aborts", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell(
      space,
      "aborted nested child parent",
      undefined,
      tx,
    );
    const before = new Set(runtime.runner.cancels.keys());
    runtime.run(tx, Parent, { value: 3 }, parent);
    const created = [...runtime.runner.cancels.keys()].filter((k) =>
      !before.has(k)
    );
    expect(created.length).toBeGreaterThanOrEqual(2);

    expect(tx.abort("parent setup rejected").error).toBeUndefined();
    await runtime.idle();

    expect(created.filter((k) => runtime.runner.cancels.has(k))).toEqual([]);
  });

  it("keeps a directly started nested child after its parent stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell<{ child: { doubled: number } }>(
      space,
      "directly started nested child parent",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Parent, { value: 3 }, parent);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(await result.pull()).toEqual({ child: { doubled: 6 } });
    const child = result.key("child").resolveAsCell() as Cell<
      { doubled: number }
    >;

    const directStart = runtime.start(child);
    runtime.runner.stop(parent);

    await expect(directStart).resolves.toBe(true);
    expect(runtime.runner.cancels.has(key(child))).toBe(true);
    runtime.runner.stop(child);
  });

  it("keeps a directly started map child after its parent stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const op = pattern(({ element }: { element: number }) =>
      lift((value: number) => value)(element)
    );
    const Parent = pattern<{ values?: number[] }>(({ values }) => {
      const list = values as unknown as OpaqueCell<number[]>;
      return {
        values,
        out: list.mapWithPattern(
          op as unknown as Parameters<typeof list.mapWithPattern>[0],
          {},
        ),
      };
    });
    const tx = runtime.edit();
    const parent = runtime.getCell<Record<string, unknown>>(
      space,
      "directly started map child parent",
      undefined,
      tx,
    );
    let child: Cell<unknown> | undefined;
    const capture = (args: unknown[]) => {
      const options = args[4] as
        | { doNotUpdateOnPatternChange?: boolean }
        | undefined;
      if (child === undefined && options?.doNotUpdateOnPatternChange === true) {
        child = args[3] as Cell<unknown>;
      }
    };
    const runner = runtime.runner as unknown as Record<string, unknown>;
    const originalRun = runtime.runner.run;
    const originalRunChild = runner.runChild as
      | ((...args: unknown[]) => unknown)
      | undefined;
    runtime.runner.run = ((...args: unknown[]) => {
      capture(args);
      return Reflect.apply(originalRun, runtime.runner, args);
    }) as typeof runtime.runner.run;
    if (originalRunChild !== undefined) {
      runner.runChild = (...args: unknown[]) => {
        capture(args);
        return Reflect.apply(originalRunChild, runtime.runner, args);
      };
    }
    try {
      runtime.run(tx, Parent, { values: [1] }, parent);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await parent.pull();
    } finally {
      runtime.runner.run = originalRun;
      if (originalRunChild !== undefined) runner.runChild = originalRunChild;
    }
    expect(child).toBeDefined();

    const directStart = runtime.start(child!);
    runtime.runner.stop(parent);

    await expect(directStart).resolves.toBe(true);
    expect(runtime.runner.cancels.has(key(child!))).toBe(true);
    runtime.runner.stop(child!);
  });

  it("tombstones a pending commit-gated start on an explicit stop", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "stopped before its deferred start",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    runtime.runner.stop(result);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });

  it("cancels a pending commit-gated start on release", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "released before its deferred start",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    // The launch holds this result through the pending start alone: nothing is
    // registered under its key until that start installs.
    expect(runtime.runner.cancels.has(key(result))).toBe(false);

    runtime.runner.releaseChild(result, undefined);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });

  it("tombstones a pending commit-gated start when the runtime stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "stopped by teardown before its deferred start",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    runtime.runner.stopAll();
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });

  it("keeps a child whose setup transaction fails on a stale basis", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell(
      space,
      "stale basis parent",
      undefined,
      tx,
    );
    const before = new Set(runtime.runner.cancels.keys());
    runtime.run(tx, Parent, { value: 3 }, parent);
    const created = [...runtime.runner.cancels.keys()].filter((k) =>
      !before.has(k)
    );
    expect(created.length).toBeGreaterThanOrEqual(2);

    // A conflict is resolved by re-running against fresher state, and that
    // re-run reuses what is already registered.
    (tx.tx as unknown as { commit: () => Promise<unknown> }).commit = () =>
      Promise.resolve({
        error: { name: "ConflictError", message: "stale basis" },
      });
    await tx.commit();
    await runtime.idle();

    expect(created.filter((k) => runtime.runner.cancels.has(k)))
      .toEqual(created);
    for (const cell of [parent]) runtime.runner.stop(cell);
  });

  it("declines to release a registration it does not own", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "released by a stale owner",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(runtime.runner.cancels.has(key(result))).toBe(true);

    // A release naming a registration that is no longer current belongs to an
    // attempt something else replaced, so it leaves the live one alone.
    runtime.runner.releaseChild(result, () => {});

    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    runtime.runner.stop(result);
  });

  it("keeps a child started before its parent stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell<{ child: { doubled: number } }>(
      space,
      "child started before its parent stops",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Parent, { value: 3 }, parent);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    const child = result.key("child").resolveAsCell() as Cell<
      { doubled: number }
    >;

    // The start settles first, so the release consults the recorded lifetime
    // rather than an attempt still in flight.
    await expect(runtime.start(child)).resolves.toBe(true);
    runtime.runner.stop(parent);

    expect(runtime.runner.cancels.has(key(child))).toBe(true);
    const update = runtime.edit();
    child.getArgumentCell()!.withTx(update).key("value").set(5);
    expect((await update.commit()).error).toBeUndefined();
    expect(await child.pull()).toEqual({ doubled: 10 });
    runtime.runner.stop(child);
  });

  it("stops tracking a commit-gated start once it installs", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "deferred start that installs",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const pending = (runtime.runner as unknown as {
      pendingDeferredStarts: Map<string, Set<unknown>>;
    }).pendingDeferredStarts;
    expect(pending.size).toBe(1);

    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    // The installed registration owns itself from here, so nothing is left
    // waiting to be tombstoned.
    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    expect(pending.size).toBe(0);
    runtime.runner.stop(result);
  });

  it("waits for producer and start waves before settling a commit-gated start", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const producerWave = new WaveAccumulator({
      space,
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (target) => storageManager.open(target).replica,
    });
    const startWave = new WaveAccumulator({
      space,
      basisSeq: 1,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (target) => storageManager.open(target).replica,
    });
    let activeWave = producerWave;
    let sealChain = Promise.resolve();
    const startSealed = Promise.withResolvers<IExtendedStorageTransaction>();
    runtime.installSealDestination(
      {
        seal: (sealTx) => {
          const wave = activeWave;
          const sealed = sealChain.then(() => wave.seal(sealTx));
          sealChain = sealed.then(() => undefined, () => undefined);
          return sealed.then((result) => {
            if (
              waveRunContextOf(sealTx)?.actionId.startsWith("piece-start/") &&
              waveSettlementOf(sealTx) !== undefined
            ) {
              startSealed.resolve(sealTx);
            }
            return result;
          });
        },
      },
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    const producerTx = runtime.edit();
    const tx = new TransactionWrapper(producerTx);
    producerTx.tx.immediate = true;
    (producerTx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    stampWaveRunContext(producerTx, {
      actionId: "producer-for-deferred-start",
      kind: "bookkeeping",
    });
    const marker = runtime.getCell<{ ready: boolean }>(
      space,
      "producer marker for deferred pattern run",
      undefined,
      producerTx,
    );
    marker.withTx(tx).set({ ready: true });
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start after producer wave settlement",
      undefined,
      producerTx,
    );
    const harness = runtime.runner as unknown as {
      runPatternAfterSuccessfulCommit(
        tx: IExtendedStorageTransaction,
        resultCell: Cell<unknown>,
        pattern: unknown,
        inputs: unknown,
        pullOnceAfterStart?: boolean,
        markCreateOnlyResult?: boolean,
      ): () => void;
    };
    harness.runPatternAfterSuccessfulCommit(
      tx,
      result,
      trustExecutable(runtime, Piece),
      { value: 3 },
      true,
      true,
    );

    expect((await producerTx.commit()).error).toBeUndefined();
    expect(waveSettlementOf(producerTx)).toBeDefined();
    expect(waveSettlementOf(tx)).toBeUndefined();
    await Promise.resolve();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
    expect(
      (runtime.runner as unknown as {
        pendingDeferredStarts: Map<string, Set<unknown>>;
      }).pendingDeferredStarts.size,
    ).toBe(1);

    activeWave = startWave;
    const acceptingSink = (head: number, seq: number): WaveCommitSink => ({
      currentHeads: (_target, docs) =>
        Promise.resolve(
          new Map(docs.map((doc) => [`${doc.id} ${doc.scopeKey}`, head])),
        ),
      concurrentWritePaths: () => Promise.resolve([]),
      commitWave: () => Promise.resolve({ ok: { seq } }),
    });
    const producerOutcome = await producerWave.commitWave(
      acceptingSink(0, 1),
    );
    await producerWave.settled();
    expect(producerOutcome.dispositions).toEqual([{ kind: "committed" }]);

    const startTx = await startSealed.promise;
    await sealChain;
    expect(waveSettlementOf(startTx)).toBeDefined();
    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    const startOutcome = await startWave.commitWave(acceptingSink(1, 2));
    await startWave.settled();
    expect(startOutcome.dispositions).toEqual([{ kind: "committed" }]);
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    runtime.runner.stop(result);
  });

  it("starts an event-handler child before its producing wave settles", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const runner = runtime.runner as unknown as {
      startWithTx(...args: unknown[]): (() => void) | undefined;
      cancels: Map<string, () => void>;
      allCancels: Set<() => void>;
    };
    const originalStartWithTx = runner.startWithTx;
    const cleanupCalled = Promise.withResolvers<void>();
    runner.startWithTx = function (...args: unknown[]) {
      const installedCancel = Reflect.apply(
        originalStartWithTx,
        runtime.runner,
        args,
      ) as (() => void) | undefined;
      if (installedCancel === undefined) return undefined;
      const throwingCancel = () => {
        installedCancel();
        cleanupCalled.resolve();
        throw new Error("test producer-wave cleanup failure");
      };
      runner.cancels.set(key(args[1] as Cell<unknown>), throwingCancel);
      runner.allCancels.delete(installedCancel);
      runner.allCancels.add(throwingCancel);
      return throwingCancel;
    };
    const wave = new WaveAccumulator({
      space,
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (target) => storageManager.open(target).replica,
    });
    let sealChain = Promise.resolve();
    let startTx: IExtendedStorageTransaction | undefined;
    runtime.installSealDestination({
      seal: (sealTx) => {
        const sealed = sealChain.then(() => wave.seal(sealTx));
        sealChain = sealed.then(() => undefined, () => undefined);
        if (waveRunContextOf(sealTx)?.actionId.startsWith("piece-start/")) {
          startTx = sealTx;
        }
        return sealed;
      },
    }, {
      runStamper: (sealTx, info) => {
        stampWaveRunContext(sealTx, {
          actionId: info.actionId,
          kind: info.kind,
          eventId: info.eventId,
        });
      },
    });

    const producerTx = runtime.edit();
    const tx = new TransactionWrapper(producerTx);
    producerTx.tx.immediate = true;
    (producerTx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    stampWaveRunContext(producerTx, {
      actionId: "event-producer-for-deferred-start",
      kind: "event-handler",
      eventId: "event-with-child",
    });
    const marker = runtime.getCell<{ ready: boolean }>(
      space,
      "event producer marker for deferred pattern run",
      undefined,
      producerTx,
    );
    marker.withTx(tx).set({ ready: true });
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "event child in its producing wave",
      undefined,
      producerTx,
    );
    const harness = runtime.runner as unknown as {
      runPatternAfterSuccessfulCommit(
        tx: IExtendedStorageTransaction,
        resultCell: Cell<unknown>,
        pattern: unknown,
        inputs: unknown,
        pullOnceAfterStart?: boolean,
        markCreateOnlyResult?: boolean,
      ): () => void;
    };
    harness.runPatternAfterSuccessfulCommit(
      tx,
      result,
      trustExecutable(runtime, Piece),
      { value: 3 },
      true,
      true,
    );

    expect((await producerTx.commit()).error).toBeUndefined();
    await sealChain;

    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    expect(waveSettlementOf(producerTx)).toBeDefined();
    expect(waveSettlementOf(tx)).toBeUndefined();
    expect(waveRunContextOf(startTx!)?.kind).toBe("event-handler");
    expect(waveRunContextOf(startTx!)?.eventId).toBe("event-with-child");

    runtime.clearSealDestination();
    const markerId = marker.getAsNormalizedFullLink().id;
    const outcome = await wave.commitWave({
      currentHeads: (_target, docs) =>
        Promise.resolve(
          new Map(docs.map((doc) => [
            `${doc.id} ${doc.scopeKey}`,
            doc.id === markerId ? 0 : 1,
          ])),
        ),
      concurrentWritePaths: () => Promise.resolve([[]]),
      commitWave: () => Promise.resolve({ ok: { seq: 1 } }),
    });
    await wave.settled();
    await cleanupCalled.promise;
    await Promise.resolve();

    expect(outcome.requeuedEventIds).toEqual(["event-with-child"]);
    expect(outcome.dispositions.length).toBeGreaterThanOrEqual(2);
    expect(outcome.dispositions.every(({ kind }) => kind === "requeued"))
      .toBe(true);
    expect(runtime.runner.cancels.has(key(result))).toBe(false);
    expect(
      (runtime.runner as unknown as {
        pendingDeferredStarts: Map<string, Set<unknown>>;
      }).pendingDeferredStarts.size,
    ).toBe(0);
    runner.startWithTx = originalStartWithTx;
  });

  it("requeues an event when deferred child setup fails before sealing", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const wave = new WaveAccumulator({
      space,
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (target) => storageManager.open(target).replica,
    });
    let sealChain = Promise.resolve();
    runtime.installSealDestination(
      {
        seal: (sealTx) => {
          const sealed = sealChain.then(() => wave.seal(sealTx));
          sealChain = sealed.then(() => undefined, () => undefined);
          return sealed;
        },
        noteEventConsequenceFailure: (producerTx) => {
          wave.noteSealFailure(waveRunContextOf(producerTx));
        },
      },
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
            eventId: info.eventId,
          });
        },
      },
    );

    const producerTx = runtime.edit();
    producerTx.tx.immediate = true;
    stampWaveRunContext(producerTx, {
      actionId: "event-producer-with-failed-child-setup",
      kind: "event-handler",
      eventId: "event-with-failed-child-setup",
    });
    const marker = runtime.getCell<{ ready: boolean }>(
      space,
      "producer whose child setup fails",
      undefined,
      producerTx,
    );
    marker.withTx(producerTx).set({ ready: true });
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "child that fails before sealing",
      undefined,
      producerTx,
    );
    const runner = runtime.runner as unknown as {
      runPatternAfterSuccessfulCommit(
        tx: IExtendedStorageTransaction,
        resultCell: Cell<unknown>,
        pattern: unknown,
        inputs: unknown,
        pullOnceAfterStart?: boolean,
        markCreateOnlyResult?: boolean,
      ): () => void;
      runWithStartOwnership(...args: unknown[]): unknown;
    };
    const originalRunWithStartOwnership = runner.runWithStartOwnership;
    runner.runWithStartOwnership = () => {
      throw new Error("test child setup failure");
    };
    runner.runPatternAfterSuccessfulCommit(
      producerTx,
      result,
      trustExecutable(runtime, Piece),
      { value: 3 },
      true,
      true,
    );

    expect((await producerTx.commit()).error).toBeUndefined();
    await sealChain;
    runner.runWithStartOwnership = originalRunWithStartOwnership;
    runtime.clearSealDestination();
    const outcome = await wave.commitWave({
      currentHeads: (_target, docs) =>
        Promise.resolve(
          new Map(docs.map((doc) => [`${doc.id} ${doc.scopeKey}`, 0])),
        ),
      concurrentWritePaths: () => Promise.resolve([]),
      commitWave: () => Promise.resolve({ ok: { seq: 1 } }),
    });
    await wave.settled();

    expect(outcome.requeuedEventIds).toEqual([
      "event-with-failed-child-setup",
    ]);
    expect(outcome.dispositions).toEqual([{ kind: "requeued" }]);
    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });

  it("cancels a commit-gated start when its producing wave withdraws", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const wave = new WaveAccumulator({
      space,
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (target) => storageManager.open(target).replica,
    });
    runtime.installSealDestination(wave);

    const producerTx = runtime.edit();
    const tx = new TransactionWrapper(producerTx);
    producerTx.tx.immediate = true;
    (producerTx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    stampWaveRunContext(producerTx, {
      actionId: "withdrawn-producer-for-deferred-start",
      kind: "bookkeeping",
    });
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start after withdrawn producer wave",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    expect((await producerTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    wave.abandon("test producer withdrawal");
    await wave.settled();
    await Promise.resolve();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
    expect(
      (runtime.runner as unknown as {
        pendingDeferredStarts: Map<string, Set<unknown>>;
      }).pendingDeferredStarts.size,
    ).toBe(0);
  });

  it("rebuilds a commit-gated start when its own wave withdraws", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const newWave = (basisSeq: number) =>
      new WaveAccumulator({
        space,
        basisSeq,
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (target) => storageManager.open(target).replica,
      });
    const producerWave = newWave(0);
    const firstStartWave = newWave(1);
    const recoveryWave = newWave(1);
    let activeWave = producerWave;
    let sealChain = Promise.resolve();
    const firstStartSealed = Promise.withResolvers<void>();
    const recoveryStartSealed = Promise.withResolvers<void>();
    let startSeals = 0;
    runtime.installSealDestination(
      {
        seal: (sealTx) => {
          const wave = activeWave;
          const sealed = sealChain.then(() => wave.seal(sealTx));
          sealChain = sealed.then(() => undefined, () => undefined);
          return sealed.then((result) => {
            if (
              waveRunContextOf(sealTx)?.actionId.startsWith("piece-start/") &&
              waveSettlementOf(sealTx) !== undefined
            ) {
              startSeals++;
              if (startSeals === 1) firstStartSealed.resolve();
              if (startSeals === 2) recoveryStartSealed.resolve();
            }
            return result;
          });
        },
      },
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    stampWaveRunContext(tx, {
      actionId: "producer-for-withdrawn-start-wave",
      kind: "bookkeeping",
    });
    const marker = runtime.getCell<{ ready: boolean }>(
      space,
      "producer marker for withdrawn start wave",
      undefined,
      tx,
    );
    marker.withTx(tx).set({ ready: true });
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start whose own wave withdraws",
      undefined,
      tx,
    );
    const harness = runtime.runner as unknown as {
      runPatternAfterSuccessfulCommit(
        tx: IExtendedStorageTransaction,
        resultCell: Cell<unknown>,
        pattern: unknown,
        inputs: unknown,
        pullOnceAfterStart?: boolean,
        markCreateOnlyResult?: boolean,
      ): () => void;
    };
    harness.runPatternAfterSuccessfulCommit(
      tx,
      result,
      trustExecutable(runtime, Piece),
      { value: 3 },
      true,
      true,
    );

    expect((await tx.commit()).error).toBeUndefined();
    activeWave = firstStartWave;
    const acceptingSink: WaveCommitSink = {
      currentHeads: (_target, docs) =>
        Promise.resolve(
          new Map(docs.map((doc) => [`${doc.id} ${doc.scopeKey}`, 0])),
        ),
      concurrentWritePaths: () => Promise.resolve([]),
      commitWave: () => Promise.resolve({ ok: { seq: 1 } }),
    };
    const producerOutcome = await producerWave.commitWave(acceptingSink);
    await producerWave.settled();
    expect(producerOutcome.dispositions).toEqual([{ kind: "committed" }]);
    await firstStartSealed.promise;
    await sealChain;

    activeWave = recoveryWave;
    firstStartWave.abandon("test start-wave withdrawal");
    await firstStartWave.settled();
    await recoveryStartSealed.promise;
    await sealChain;
    expect(startSeals).toBe(2);

    const recoveryOutcome = await recoveryWave.commitWave({
      ...acceptingSink,
      commitWave: () => Promise.resolve({ ok: { seq: 2 } }),
    });
    await recoveryWave.settled();
    expect(recoveryOutcome.dispositions).toEqual([{ kind: "committed" }]);
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    runtime.runner.stop(result);
  });

  it("rebuilds a commit-gated start after conflict catch-up", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start that catches up after a conflict",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const gateEntered = Promise.withResolvers<void>();
    const readyToRetry = Promise.withResolvers<void>();
    const retryCommitted = Promise.withResolvers<void>();
    let startSeals = 0;
    runtime.installSealDestination(
      {
        seal: async (sealTx: IExtendedStorageTransaction) => {
          const actionId = waveRunContextOf(sealTx)?.actionId;
          if (!actionId?.startsWith("piece-start/")) {
            return await sealTx.tx.commit();
          }
          startSeals++;
          if (startSeals === 1) {
            return {
              error: Object.assign(new Error("test deferred-start conflict"), {
                name: "ConflictError" as const,
                transaction: {} as never,
                conflict: {
                  space,
                  the: "application/json" as const,
                  of: result.getAsNormalizedFullLink().id as never,
                },
                readyToRetry: () => {
                  gateEntered.resolve();
                  return readyToRetry.promise;
                },
              }),
            };
          }
          const committed = await sealTx.tx.commit();
          retryCommitted.resolve();
          return committed;
        },
      } satisfies TransactionSealDestination,
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    expect((await tx.commit()).error).toBeUndefined();
    await gateEntered.promise;
    expect(runtime.runner.cancels.has(key(result))).toBe(false);

    readyToRetry.resolve();
    await retryCommitted.promise;
    await runtime.idle();

    expect(startSeals).toBe(2);
    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    expect(await result.pull()).toEqual({ doubled: 6 });
    runtime.clearSealDestination();
    runtime.runner.stop(result);
  });

  it("cancels conflict catch-up when a commit-gated start stops", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start stopped during conflict catch-up",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const gateEntered = Promise.withResolvers<void>();
    const readyToRetry = Promise.withResolvers<void>();
    const gateSettled = Promise.withResolvers<void>();
    let startSeals = 0;
    runtime.installSealDestination(
      {
        seal: async (sealTx: IExtendedStorageTransaction) => {
          const actionId = waveRunContextOf(sealTx)?.actionId;
          if (!actionId?.startsWith("piece-start/")) {
            return await sealTx.tx.commit();
          }
          startSeals++;
          if (startSeals === 1) {
            return {
              error: Object.assign(new Error("test deferred-start conflict"), {
                name: "ConflictError" as const,
                transaction: {} as never,
                conflict: {
                  space,
                  the: "application/json" as const,
                  of: result.getAsNormalizedFullLink().id as never,
                },
                readyToRetry: async () => {
                  gateEntered.resolve();
                  await readyToRetry.promise;
                  gateSettled.resolve();
                },
              }),
            };
          }
          return await sealTx.tx.commit();
        },
      } satisfies TransactionSealDestination,
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    expect((await tx.commit()).error).toBeUndefined();
    await gateEntered.promise;
    runtime.runner.stop(result);

    readyToRetry.resolve();
    await gateSettled.promise;
    await Promise.resolve();

    expect(startSeals).toBe(1);
    expect(runtime.runner.cancels.has(key(result))).toBe(false);
    runtime.clearSealDestination();
  });

  it("does not rebuild a commit-gated start after a second conflict", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start that conflicts twice",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const gateEntered = Promise.withResolvers<void>();
    const readyToRetry = Promise.withResolvers<void>();
    const secondConflict = Promise.withResolvers<void>();
    let catchUpCalls = 0;
    let startSeals = 0;
    runtime.installSealDestination(
      {
        seal: async (sealTx: IExtendedStorageTransaction) => {
          const actionId = waveRunContextOf(sealTx)?.actionId;
          if (!actionId?.startsWith("piece-start/")) {
            return await sealTx.tx.commit();
          }
          startSeals++;
          const firstAttempt = startSeals === 1;
          if (!firstAttempt) secondConflict.resolve();
          return {
            error: Object.assign(new Error("test deferred-start conflict"), {
              name: "ConflictError" as const,
              transaction: {} as never,
              conflict: {
                space,
                the: "application/json" as const,
                of: result.getAsNormalizedFullLink().id as never,
              },
              readyToRetry: () => {
                catchUpCalls++;
                if (firstAttempt) {
                  gateEntered.resolve();
                  return readyToRetry.promise;
                }
                return Promise.resolve();
              },
            }),
          };
        },
      } satisfies TransactionSealDestination,
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    expect((await tx.commit()).error).toBeUndefined();
    await gateEntered.promise;
    readyToRetry.resolve();
    await secondConflict.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(startSeals).toBe(2);
    expect(catchUpCalls).toBe(1);
    expect(
      (runtime.runner as unknown as {
        pendingDeferredStarts: Map<string, Set<unknown>>;
      }).pendingDeferredStarts.size,
    ).toBe(0);
    runtime.clearSealDestination();
    runtime.runner.stop(result);
  });

  it("does not rebuild a conflict without a catch-up gate", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start whose conflict has no catch-up gate",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const conflictReturned = Promise.withResolvers<void>();
    let startSeals = 0;
    runtime.installSealDestination(
      {
        seal: async (sealTx: IExtendedStorageTransaction) => {
          const actionId = waveRunContextOf(sealTx)?.actionId;
          if (!actionId?.startsWith("piece-start/")) {
            return await sealTx.tx.commit();
          }
          startSeals++;
          conflictReturned.resolve();
          return {
            error: Object.assign(new Error("test deferred-start conflict"), {
              name: "ConflictError" as const,
              transaction: {} as never,
              conflict: {
                space,
                the: "application/json" as const,
                of: result.getAsNormalizedFullLink().id as never,
              },
            }),
          };
        },
      } satisfies TransactionSealDestination,
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    expect((await tx.commit()).error).toBeUndefined();
    await conflictReturned.promise;
    await Promise.resolve();

    expect(startSeals).toBe(1);
    expect(
      (runtime.runner as unknown as {
        pendingDeferredStarts: Map<string, Set<unknown>>;
      }).pendingDeferredStarts.size,
    ).toBe(0);
    runtime.clearSealDestination();
    runtime.runner.stop(result);
  });

  it("settles a commit-gated start after a nullish rejection", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start whose commit rejects without a reason",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const rejectionReturned = Promise.withResolvers<void>();
    runtime.installSealDestination(
      {
        seal: async (sealTx: IExtendedStorageTransaction) => {
          const actionId = waveRunContextOf(sealTx)?.actionId;
          if (!actionId?.startsWith("piece-start/")) {
            return await sealTx.tx.commit();
          }
          rejectionReturned.resolve();
          return await Promise.reject(undefined);
        },
      } satisfies TransactionSealDestination,
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    expect((await tx.commit()).error).toBeUndefined();
    await rejectionReturned.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
    expect(
      (runtime.runner as unknown as {
        pendingDeferredStarts: Map<string, Set<unknown>>;
      }).pendingDeferredStarts.size,
    ).toBe(0);
    runtime.clearSealDestination();
  });

  it("does not rebuild a commit-gated start when conflict catch-up fails", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start whose conflict catch-up fails",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const catchUpAttempted = Promise.withResolvers<void>();
    let startSeals = 0;
    runtime.installSealDestination(
      {
        seal: async (sealTx: IExtendedStorageTransaction) => {
          const actionId = waveRunContextOf(sealTx)?.actionId;
          if (!actionId?.startsWith("piece-start/")) {
            return await sealTx.tx.commit();
          }
          startSeals++;
          return {
            error: Object.assign(new Error("test conflict catch-up failure"), {
              name: "ConflictError" as const,
              transaction: {} as never,
              conflict: {
                space,
                the: "application/json" as const,
                of: result.getAsNormalizedFullLink().id as never,
              },
              readyToRetry: () => {
                catchUpAttempted.resolve();
                return Promise.reject(new Error("test catch-up failure"));
              },
            }),
          };
        },
      } satisfies TransactionSealDestination,
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    expect((await tx.commit()).error).toBeUndefined();
    await catchUpAttempted.promise;
    await Promise.resolve();

    expect(startSeals).toBe(1);
    runtime.clearSealDestination();
    runtime.runner.stop(result);
  });

  it("settles a failed commit-gated start when cleanup throws", async () => {
    await useServerExecutionRuntime();
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "deferred start whose failed cleanup throws",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const runner = runtime.runner as unknown as {
      startWithTx(...args: unknown[]): (() => void) | undefined;
      cancels: Map<string, () => void>;
      allCancels: Set<() => void>;
    };
    const originalStartWithTx = runner.startWithTx;
    const cleanupCalled = Promise.withResolvers<void>();
    runner.startWithTx = function (...args: unknown[]) {
      const installedCancel = Reflect.apply(
        originalStartWithTx,
        runtime.runner,
        args,
      ) as (() => void) | undefined;
      if (installedCancel === undefined) return undefined;
      const throwingCancel = () => {
        installedCancel();
        cleanupCalled.resolve();
        throw new Error("test cleanup failure");
      };
      runner.cancels.set(key(args[1] as Cell<unknown>), throwingCancel);
      runner.allCancels.delete(installedCancel);
      runner.allCancels.add(throwingCancel);
      return throwingCancel;
    };
    runtime.installSealDestination(
      {
        seal: async (sealTx: IExtendedStorageTransaction) => {
          const actionId = waveRunContextOf(sealTx)?.actionId;
          if (!actionId?.startsWith("piece-start/")) {
            return await sealTx.tx.commit();
          }
          return {
            error: {
              name: "StorageTransactionAborted" as const,
              message: "test deferred-start failure",
              reason: "test deferred-start failure",
            },
          };
        },
      } satisfies TransactionSealDestination,
      {
        runStamper: (sealTx, info) => {
          stampWaveRunContext(sealTx, {
            actionId: info.actionId,
            kind: info.kind,
          });
        },
      },
    );

    try {
      expect((await tx.commit()).error).toBeUndefined();
      await cleanupCalled.promise;
      await runtime.idle();

      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      runner.startWithTx = originalStartWithTx;
      runtime.clearSealDestination();
    }
  });

  it("stops tracking a commit-gated start when its transaction fails", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "deferred start whose transaction fails",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    const pending = (runtime.runner as unknown as {
      pendingDeferredStarts: Map<string, Set<unknown>>;
    }).pendingDeferredStarts;
    expect(pending.size).toBe(1);

    expect(tx.abort("setup rejected").error).toBeUndefined();
    await runtime.idle();

    // The start will never install, so it settles as cancelled and leaves
    // nothing behind for the result's key.
    expect(runtime.runner.cancels.has(key(result))).toBe(false);
    expect(pending.size).toBe(0);
  });

  it("stops tracking a commit-gated pattern run when its transaction fails", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    // The commit-gated run a navigateTo handler schedules goes through its own
    // entry point, reached here directly: driving it through a handler would
    // mean failing whichever storage transaction the dispatch happened to
    // land on.
    const harness = runtime.runner as unknown as {
      runPatternAfterSuccessfulCommit(
        tx: unknown,
        resultCell: unknown,
        pattern: unknown,
        inputs: unknown,
        pullOnceAfterStart?: boolean,
        markCreateOnlyResult?: boolean,
      ): () => void;
      pendingDeferredStarts: Map<string, Set<unknown>>;
    };
    const tx = runtime.edit();
    const receipt = runtime.getCell<Record<string, unknown>>(
      space,
      "deferred pattern run whose transaction fails",
      undefined,
      tx,
    );
    harness.runPatternAfterSuccessfulCommit(
      tx,
      receipt,
      trustExecutable(runtime, Piece),
      { value: 3 },
      true,
      true,
    );
    expect(harness.pendingDeferredStarts.size).toBe(1);

    expect(tx.abort("handler rejected").error).toBeUndefined();
    await runtime.idle();

    expect(harness.pendingDeferredStarts.size).toBe(0);
    expect(runtime.runner.cancels.has(key(receipt))).toBe(false);
  });

  it("declines to release a result that has no registration", () => {
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "released while never started",
    );
    expect(runtime.runner.cancels.has(key(result))).toBe(false);

    runtime.runner.releaseChild(result, undefined);

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });
});
