import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { resolveLink } from "../src/link-resolution.ts";
import {
  beginReadAccounting,
  finishReadAccounting,
} from "../src/read-accounting.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
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

  for (const lazy of [false, true]) {
    describe(lazy ? "schema views" : "query-result views", () => {
      const view = (tx: IExtendedStorageTransaction) => {
        if (lazy) tx.markLazyMaterialize(true);
        return runtime.getCell<
          { value: number; absent?: number; items: number[] }
        >(
          space,
          "source",
          lazy ? schema : undefined,
          tx,
        ).get();
      };

      it("counts repeated and missing property requests independently of documents", () => {
        const tx = runtime.edit();
        beginReadAccounting(tx);
        const data = view(tx);
        expect(data.value).toBe(7);
        expect(data.value).toBe(7);
        expect(data.absent).toBeUndefined();
        const counts = finishReadAccounting(tx)!;
        expect(counts.proxyAccesses).toBe(3);
        expect(counts.distinctDocuments).toBe(1);
        expect(counts.linkResolutions).toBe(0);
        tx.abort();
      });

      it("counts array materialization and iteration even when methods bypass proxy traps", () => {
        const tx = runtime.edit();
        beginReadAccounting(tx);
        const items = view(tx).items;
        expect(items.map((n) => n * 2)).toEqual([2, 4, 6]);
        expect([...items]).toEqual([1, 2, 3]);
        expect(items.length).toBe(3);
        expect(items[9]).toBeUndefined();
        expect(finishReadAccounting(tx)!.proxyAccesses).toBe(9);
        tx.abort();
      });

      it("leaves unmeasured transactions and completed counters absent", () => {
        const tx = runtime.edit();
        expect(view(tx).value).toBe(7);
        expect(finishReadAccounting(tx)).toBeUndefined();
        beginReadAccounting(tx);
        expect(view(tx).value).toBe(7);
        expect(finishReadAccounting(tx)!.proxyAccesses).toBe(1);
        expect(view(tx).value).toBe(7);
        expect(finishReadAccounting(tx)).toBeUndefined();
        tx.abort();
      });

      it("counts descriptor value reads but not key enumeration alone", () => {
        const tx = runtime.edit();
        beginReadAccounting(tx);
        const data = view(tx);
        Reflect.ownKeys(data);
        expect(Object.getOwnPropertyDescriptor(data, "value")!.value).toBe(7);
        expect(finishReadAccounting(tx)!.proxyAccesses).toBe(1);
        tx.abort();
      });
    });
  }

  it("shares counts through nonreactive wrappers without sharing across transactions", () => {
    const tx = runtime.edit();
    const other = runtime.edit();
    beginReadAccounting(tx);
    beginReadAccounting(other);
    const wrapped = createNonReactiveTransaction(tx);
    expect(
      runtime.getCell<{ value: number }>(space, "source", undefined, wrapped)
        .get().value,
    ).toBe(7);
    expect(finishReadAccounting(other)).toEqual({
      proxyAccesses: 0,
      linkResolutions: 0,
      distinctDocuments: 0,
    });
    expect(finishReadAccounting(tx)!.proxyAccesses).toBe(1);
    tx.abort();
    other.abort();
  });

  it("preserves the read log and subscription paths when accounting is enabled", () => {
    const read = (enabled: boolean) => {
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      if (enabled) beginReadAccounting(tx);
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
      const counts = finishReadAccounting(tx);
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
    beginReadAccounting(left);
    beginReadAccounting(right);
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
      expect(finishReadAccounting(left)!.proxyAccesses).toBe(1);
      expect(finishReadAccounting(right)!.proxyAccesses).toBe(2);
    } finally {
      left.abort();
      right.abort();
      await second.dispose({ closeStorage: false });
    }
  });

  it("counts actual link hops but not memoized resolution replay", async () => {
    const write = runtime.edit();
    const source = runtime.getCell<{ value: number }>(
      space,
      "source",
      undefined,
      write,
    );
    const middle = runtime.getCell(space, "middle", undefined, write);
    middle.setRaw(source.key("value").getAsLink());
    runtime.getCell(space, "head", undefined, write).setRaw(middle.getAsLink());
    await write.commit();
    const tx = runtime.edit();
    beginReadAccounting(tx);
    const head = runtime.getCell(space, "head", undefined, tx)
      .getAsNormalizedFullLink();
    expect(resolveLink(runtime, tx, head).id).toBe(
      source.getAsNormalizedFullLink().id,
    );
    resolveLink(runtime, tx, head);
    const counts = finishReadAccounting(tx)!;
    expect(counts.linkResolutions).toBe(2);
    expect(counts.distinctDocuments).toBe(3);
    tx.abort();
  });

  it("counts links traversed while eagerly materializing a schema", async () => {
    const write = runtime.edit();
    const source = runtime.getCell(space, "source", undefined, write);
    runtime.getCell(space, "eager-holder", undefined, write).setRaw({
      target: source.getAsLink(),
    });
    await write.commit();
    const tx = runtime.edit();
    beginReadAccounting(tx);
    const value = runtime.getCell<{ target: { value: number } }>(
      space,
      "eager-holder",
      {
        type: "object",
        properties: {
          target: { type: "object", properties: { value: { type: "number" } } },
        },
      },
      tx,
    ).get();
    expect(value.target.value).toBe(7);
    const counts = finishReadAccounting(tx)!;
    expect(counts.proxyAccesses).toBe(0);
    expect(counts.linkResolutions).toBe(1);
    expect(counts.distinctDocuments).toBe(2);
    tx.abort();
  });

  it("keeps identical document IDs in different spaces distinct", () => {
    const tx = runtime.edit();
    beginReadAccounting(tx);
    const cell = runtime.getCell(space, "source", undefined, tx);
    const link = cell.getAsNormalizedFullLink();
    tx.readValueOrThrow(link);
    tx.read({
      space: otherSpace,
      id: link.id,
      path: ["value"],
      scope: "space",
    });
    expect(finishReadAccounting(tx)!.distinctDocuments).toBe(2);
    tx.abort();
  });

  it("compacts scheduling dependencies separately from recorded documents", async () => {
    runtime.scheduler.setReadAccountingEnabled(true);
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
    expect(runtime.scheduler.getActionStats(action)!.reads!.last).toEqual({
      proxyAccesses: 0,
      linkResolutions: 0,
      distinctDocuments: 1,
      dependencies: 2,
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
    runtime.scheduler.setReadAccountingEnabled(true);
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
    runtime.scheduler.setReadAccountingEnabled(false);
    barrier.resolve();
    await runtime.idle();
    expect(errors.some((e) => e.message === "measured failure")).toBe(true);
    expect(runtime.scheduler.getActionStats(action)!.reads!.last.proxyAccesses)
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
    runtime.scheduler.setReadAccountingEnabled(true);
    const running = runtime.scheduler.run(action);
    try {
      await entered.promise;
      runtime.scheduler.setReadAccountingEnabled(false);
      release.resolve();
      await running;
      expect(runs).toBe(2);
      const stats = runtime.scheduler.getActionStats(action)!;
      expect(stats.reads!.runCount).toBe(2);
      expect(stats.reads!.total.proxyAccesses).toBe(2);
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
      runtime.scheduler.setReadAccountingEnabled(true);
      await run();
      await run();
      const stats = runtime.scheduler.getActionStats(action)!;
      expect(stats.runCount).toBe(3);
      expect(stats.reads!.runCount).toBe(2);
      expect(stats.reads!.last.proxyAccesses).toBe(2);
      expect(stats.reads!.total.proxyAccesses).toBe(4);
      expect(stats.reads!.last.dependencies).toBeGreaterThan(0);
      const measured = markers.filter((m) =>
        m.type === "scheduler.run.complete" && m.reads !== undefined
      );
      expect(measured).toHaveLength(2);
      runtime.scheduler.setReadAccountingEnabled(false);
      await run();
      expect(runtime.scheduler.getActionStats(action)!.reads!.runCount).toBe(2);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
      runtime.scheduler.unsubscribe(action);
    }
  });
});
