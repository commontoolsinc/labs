import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { startReadStats } from "../src/read-stats.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { ignoreReadForScheduling } from "../src/storage/reactivity-log.ts";
import {
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
} from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("read-accounting");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("read-accounting-other"))
  .did();
const schema = {
  type: "object",
  properties: {
    value: { type: "number" },
    absent: { type: "number" },
    items: { type: "array", items: { type: "number" } },
  },
} as const satisfies JSONSchema;

describe("read-accounting", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const tx = runtime.edit();
    runtime.getCell(space, "source", undefined, tx).set({
      value: 7,
      items: [1, 2, 3],
    });
    await tx.commit();
  });

  afterEach(async () => {
    await runtime.idle();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  it("shares counts through nonreactive wrappers without sharing across transactions", () => {
    const tx = runtime.edit();
    const other = runtime.edit();
    const finish = startReadStats(tx);
    const finishOther = startReadStats(other);
    const wrapped = createNonReactiveTransaction(tx);
    expect(
      runtime.getCell<{ value: number }>(space, "source", undefined, wrapped)
        .get().value,
    ).toBe(7);
    expect(finishOther(0)).toEqual({
      proxyAccesses: 0,
      linkResolutions: 0,
      distinctDocuments: 0,
      registeredDependencies: 0,
    });
    expect(finish(0).proxyAccesses).toBe(1);
    tx.abort();
    other.abort();
  });

  it("preserves the read log and subscription paths when accounting is enabled", () => {
    const read = (enabled: boolean) => {
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      const finish = enabled ? startReadStats(tx) : undefined;
      const data = runtime.getCell<{ value: number; items: number[] }>(
        space,
        "source",
        schema,
        tx,
      ).get();
      const result = data.value +
        data.items.reduce((sum, value) => sum + value, 0);
      const before = tx.getReactivityLog?.();
      expect(before).toBeDefined();
      const counts = finish?.(0);
      const after = tx.getReactivityLog?.();
      expect(after).toEqual(before);
      tx.abort();
      return { result, log: after, counts };
    };
    const disabled = read(false);
    const enabled = read(true);
    expect(enabled.result).toBe(13);
    expect(enabled.result).toBe(disabled.result);
    expect(enabled.log).toEqual(disabled.log);
    expect(disabled.counts).toBeUndefined();
    expect(enabled.counts!.proxyAccesses).toBe(5);
  });

  it("isolates measured reads from two runtimes sharing storage", async () => {
    const second = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const left = runtime.edit();
    const right = second.edit();
    const finishLeft = startReadStats(left);
    const finishRight = startReadStats(right);
    try {
      const a = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        left,
      ).get();
      const b = second.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        right,
      ).get();
      expect(a.value + b.value + b.value).toBe(21);
      expect(finishLeft(0).proxyAccesses).toBe(1);
      expect(finishRight(0).proxyAccesses).toBe(2);
    } finally {
      left.abort();
      right.abort();
      await second.dispose({ closeStorage: false });
    }
  });

  it("attributes standing proxy reads to the selected fallback transaction", () => {
    const original = runtime.edit();
    const data = runtime.getCell<{ value: number; items: number[] }>(
      space,
      "source",
      undefined,
      original,
    ).get();
    const items = data.items;
    const finishOriginal = startReadStats(original);
    original.abort();
    const fallback = runtime.edit();
    const finishFallback = startReadStats(fallback);
    using _readTx = stub(
      runtime,
      "readTx",
      (tx) => tx?.status().status === "ready" ? tx : fallback,
    );
    try {
      expect(data.value).toBe(7);
      expect(items.length).toBe(3);
      expect([...items]).toEqual([1, 2, 3]);
      expect(items.map((n) => n * 2)).toEqual([2, 4, 6]);
      expect(Object.getOwnPropertyDescriptor(data, "value")!.get!.call(data))
        .toBe(7);
      expect(Object.getOwnPropertyDescriptor(items, "length")!.value).toBe(3);
      expect(finishFallback(0).proxyAccesses).toBe(10);
      expect(finishOriginal(0).proxyAccesses).toBe(0);
    } finally {
      finishOriginal(0);
      finishFallback(0);
      fallback.abort();
    }
  });

  it("counts missing schema-array index reads", () => {
    const tx = runtime.edit();
    tx.markLazyMaterialize();
    const data = runtime.getCell<{ items: number[] }>(
      space,
      "source",
      schema,
      tx,
    ).get();
    const items = data.items;
    const finish = startReadStats(tx);
    try {
      expect(items[99]).toBeUndefined();
      expect(finish(0).proxyAccesses).toBe(1);
    } finally {
      finish(0);
      tx.abort();
    }
  });

  it("compacts scheduling dependencies separately from recorded documents", async () => {
    runtime.scheduler.setReadStatsEnabled(true);
    const cell = runtime.getCell(space, "source");
    const link = cell.getAsNormalizedFullLink();
    const action: Action = (tx) => {
      const address = {
        space,
        id: link.id,
        scope: "space" as const,
        path: ["value", "value"],
      };
      tx.read(address);
      tx.read(address);
      tx.read({ ...address, path: ["value"] }, { nonRecursive: true });
      tx.read({ ...address, path: ["value", "items"] }, {
        meta: ignoreReadForScheduling,
      });
    };
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    runtime.scheduler.queueExecution();
    await runtime.idle();
    expect(runtime.scheduler.getActionStats(action)!.lastRunReads!).toEqual({
      proxyAccesses: 0,
      linkResolutions: 0,
      distinctDocuments: 1,
      registeredDependencies: 2,
    });
    runtime.scheduler.unsubscribe(action);
  });

  it("records reads before an action throws and isolates an asynchronous run", async () => {
    const errors: Error[] = [];
    await runtime.dispose({ closeStorage: false });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      errorHandlers: [(error) => errors.push(error)],
    });
    runtime.scheduler.setReadStatsEnabled(true);
    const barrier = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const action: Action = async (tx) => {
      const data = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      ).get();
      expect(data.value).toBe(7);
      entered.resolve();
      await barrier.promise;
      expect(data.value).toBe(7);
      throw new Error("measured failure");
    };
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    runtime.scheduler.queueExecution();
    await entered.promise;
    const other = runtime.edit();
    runtime.getCell<{ value: number }>(space, "source", undefined, other).get()
      .value;
    other.abort();
    runtime.scheduler.setReadStatsEnabled(false);
    barrier.resolve();
    await runtime.idle();
    expect(errors.some((e) => e.message === "measured failure")).toBe(true);
    expect(
      runtime.scheduler.getActionStats(action)!.lastRunReads!.proxyAccesses,
    )
      .toBe(2);
    runtime.scheduler.unsubscribe(action);
  });

  it("keeps the initial accounting setting across fan-out instances", async () => {
    using _demanders = stub(runtime, "serverRunDemandersFor", () => [
      { principal: space },
      { principal: otherSpace },
    ]);
    const scopeStubs: Stub[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let runs = 0;
    const action = Object.assign(async (tx: IExtendedStorageTransaction) => {
      scopeStubs.push(stub(tx, "getNarrowestReadScope", (): "user" => "user"));
      const value = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      ).get();
      expect(value.value).toBe(7);
      if (++runs === 1) {
        entered.resolve();
        await release.promise;
      }
    }, { schedulerObservationIdentity: { pieceRootId: "read-accounting" } });
    runtime.scheduler.setReadStatsEnabled(true);
    const running = runtime.scheduler.run(action);
    try {
      await entered.promise;
      runtime.scheduler.setReadStatsEnabled(false);
      release.resolve();
      await running;
      expect(runs).toBe(2);
      const stats = runtime.scheduler.getActionStats(action)!;
      expect(stats.reads!.proxyAccesses).toBe(2);
      expect(stats.reads!.proxyAccesses).toBe(2);
    } finally {
      release.resolve();
      await running;
      for (const scope of scopeStubs) scope.restore();
    }
  });

  it("records each enabled scheduler run and preserves unmeasured run counts", async () => {
    const markers: RuntimeTelemetryMarker[] = [];
    const listener = (event: Event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    };
    runtime.telemetry.addEventListener("telemetry", listener);
    const action: Action = (tx) => {
      const value = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      ).get();
      expect(value.value + value.value).toBe(14);
    };
    const run = async () => {
      runtime.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      runtime.scheduler.queueExecution();
      await runtime.idle();
    };
    try {
      await run();
      expect(runtime.scheduler.getActionStats(action)!.reads).toBeUndefined();
      runtime.scheduler.setReadStatsEnabled(true);
      await run();
      await run();
      const stats = runtime.scheduler.getActionStats(action)!;
      expect(stats.runCount).toBe(3);
      expect(stats.reads!.proxyAccesses).toBe(4);
      expect(stats.lastRunReads!.proxyAccesses).toBe(2);
      expect(stats.reads!.proxyAccesses).toBe(4);
      expect(stats.lastRunReads!.registeredDependencies).toBeGreaterThan(0);
      const measured = markers.filter((m) =>
        m.type === "scheduler.run.complete" && m.reads !== undefined
      );
      expect(measured).toHaveLength(2);
      runtime.scheduler.setReadStatsEnabled(false);
      await run();
      expect(runtime.scheduler.getActionStats(action)!.reads!.proxyAccesses)
        .toBe(4);
      expect(runtime.scheduler.getActionStats(action)!.lastRunReads)
        .toBeUndefined();
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
      runtime.scheduler.unsubscribe(action);
    }
  });
});
