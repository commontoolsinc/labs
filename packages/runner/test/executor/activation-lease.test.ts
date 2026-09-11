import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";

import { Identity } from "@commonfabric/identity";
import { resolveScopeKey, streamEntriesDocId } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  acquireExecutionLease,
  ExecutionLeaseCycle,
  executionLeaseHolder,
  liveExecutionLeaseHolder,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import { defer } from "@commonfabric/utils/defer";

import { ExecutorHost } from "../../src/executor/host.ts";
import {
  type RuntimeFactoryContext,
  SpaceServer,
} from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import {
  stampWaveRunContext,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("activation lease space");
const serviceSigner = await Identity.fromPassphrase("activation lease service");
const aliceSigner = await Identity.fromPassphrase("activation lease alice");
const space = spaceSigner.did() as MemorySpace;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

async function fixture(options: {
  factoryError?: Error;
  disposeError?: Error;
  servingPosture?: boolean;
  serverExecution?: boolean;
  serverFacade?: (
    server: ReturnType<typeof newSharedServer>,
  ) => ReturnType<typeof newSharedServer>;
} = {}) {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const engine = await server.engineForSpace(space);
  const manager = EmulatedStorageManager.connectTo(server, {
    as: serviceSigner,
  });
  let runtime: Runtime;
  try {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: options.servingPosture ?? true,
      experimental: { serverExecution: options.serverExecution ?? true },
    });
  } catch (error) {
    await manager.close();
    await server.close();
    throw error;
  }
  let transferred = false;
  let disposeCalls = 0;
  const entered = defer<RuntimeFactoryContext>();
  const release = defer<void>();
  const disposeEntered = defer<void>();
  let disposeGate: Promise<void> | undefined;
  const stats = emptyServingLoopStats();
  const dispose = async () => {
    disposeCalls++;
    disposeEntered.resolve();
    await disposeGate;
    try {
      await runtime.dispose();
    } catch (error) {
      await manager.close();
      throw error;
    }
    if (options.disposeError) throw options.disposeError;
  };
  const createRuntime = async (context: RuntimeFactoryContext) => {
    entered.resolve(context);
    await release.promise;
    if (options.factoryError) throw options.factoryError;
    transferred = true;
    return { runtime, dispose };
  };
  const serving = new SpaceServer({
    space,
    engine,
    server: options.serverFacade?.(server) ?? server,
    serviceIdentity: serviceSigner.did(),
    createRuntime,
    localSeqRef: { value: 0 },
    stats,
    policy: {
      flushDeadlineMs: 2_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    },
  });
  return {
    server,
    engine,
    manager,
    runtime,
    entered,
    release,
    stats,
    serving,
    createRuntime,
    disposeEntered,
    holdDisposal(gate: Promise<void>) {
      disposeGate = gate;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    async close(activation?: Promise<unknown>) {
      release.resolve();
      await activation?.catch(() => {});
      try {
        await serving.park("test-teardown");
        if (!transferred) await dispose();
      } finally {
        await server.close();
      }
    },
  };
}

async function commitFirstWork(f: Awaited<ReturnType<typeof fixture>>) {
  const probe = f.runtime.getCell<number>(space, "first-work", undefined);
  await probe.sync();
  const tx = f.runtime.edit();
  stampWaveRunContext(tx, { actionId: "first-work", kind: "derivation" });
  probe.withTx(tx).set(42);
  expect((await tx.commit()).error).toBeUndefined();
  const accepted = await waveSettlementOf(tx);
  expect(accepted).toBeDefined();
  expect(accepted?.error).toBeUndefined();
  expect(
    Engine.read(f.engine, { id: probe.getAsNormalizedFullLink().id })?.value,
  )
    .toBe(42);
}

describe("activation-lease", () => {
  for (const initializationMs of [0, 20_000]) {
    it(`commits its first work after ${initializationMs}ms of gated initialization`, async () => {
      const f = await fixture();
      // Lease time and interval callbacks advance together; scheduler and
      // transport dispatch still drain through ordinary task boundaries.
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const activation = f.serving.activate();
      try {
        await f.entered.promise;
        expect(liveExecutionLeaseHolder(f.engine, space)).toBe(
          f.serving.holder,
        );
        const initialHead = Engine.serverSeq(f.engine);
        time.tick(initializationMs);
        expect(Engine.serverSeq(f.engine)).toBe(initialHead);
        f.release.resolve();
        expect(await activation).toBe(true);
        await commitFirstWork(f);
        expect(liveExecutionLeaseHolder(f.engine, space)).toBe(
          f.serving.holder,
        );
      } finally {
        await f.close(activation);
      }
      expect(f.disposeCalls).toBe(1);
      expect(time.next()).toBe(false);
    });
  }

  it("keeps its lease while delegated append recovery opens a target space", async () => {
    const appendEntered = defer<void>();
    const releaseAppend = defer<void>();
    const f = await fixture({
      serverFacade: (server) =>
        new Proxy(server, {
          get(target, property, receiver) {
            if (property === "commitDelegatedAppend") {
              return async (
                ...args: Parameters<typeof server.commitDelegatedAppend>
              ) => {
                appendEntered.resolve();
                await releaseAppend.promise;
                return await target.commitDelegatedAppend(...args);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    const targetSigner = await Identity.fromPassphrase(
      "activation append target",
    );
    const targetSpace = targetSigner.did() as MemorySpace;
    const targetStreamLink = {
      id: "of:activation-target-stream",
      path: [] as string[],
    };
    const targetStream = streamEntriesDocId(targetStreamLink);
    insertExecutionOutboxRows(f.engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream,
        targetStreamLink,
        eventId: "activation-recovery-entry",
        payload: { recovered: true },
        actingPrincipal: aliceSigner.did(),
        actingSession: "session:activation-recovery",
        capabilityRef: "cap:activation-recovery",
      }],
    });
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      f.release.resolve();
      await appendEntered.promise;
      expect(f.serving.active).toBe(false);
      time.tick(20_000);
      releaseAppend.resolve();
      expect(await activation).toBe(true);
      expect(selectPendingExecutionOutboxRows(f.engine, { branch: "" }))
        .toHaveLength(0);
      const targetEngine = await f.server.engineForSpace(targetSpace);
      const entries = Engine.read(targetEngine, { id: targetStream })
        ?.value as { entries: unknown[] };
      expect(entries.entries).toHaveLength(1);
      await commitFirstWork(f);
    } finally {
      releaseAppend.resolve();
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
    expect(time.next()).toBe(false);
  });

  it("releases its initialization lease when the runtime factory rejects", async () => {
    const f = await fixture({ factoryError: new Error("factory rejected") });
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      time.tick(20_000);
      f.release.resolve();
      await expect(activation).rejects.toThrow("factory rejected");
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(f.stats.activeSpaces).toBe(0);
      expect(time.next()).toBe(false);
    } finally {
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
  });

  for (const invalidRuntime of ["servingPosture", "serverExecution"] as const) {
    it(`releases its lease when ${invalidRuntime} validation and disposal fail`, async () => {
      const f = await fixture({
        [invalidRuntime]: false,
        disposeError: new Error("dispose rejected"),
      });
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const activation = f.serving.activate();
      try {
        await f.entered.promise;
        f.release.resolve();
        await expect(activation).rejects.toThrow(invalidRuntime);
        expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
        expect(f.disposeCalls).toBe(1);
        expect(f.stats.activeSpaces).toBe(0);
        expect(time.next()).toBe(false);
      } finally {
        await f.close(activation);
      }
    });
  }

  it("refuses activation and stops renewal when the lease store throws", async () => {
    const f = await fixture();
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      {
        using _renew = stub(ExecutionLeaseCycle.prototype, "renew", () => {
          throw new Error("lease store unavailable");
        });
        time.tick(5_000);
      }
      f.release.resolve();
      expect(await activation).toBe(false);
      expect(f.serving.active).toBe(false);
      expect(f.stats.lease.lost).toBe(1);
      expect(f.stats.waves).toBe(0);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(time.next()).toBe(false);
    } finally {
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
  });

  it("disposes a rejected runtime even when observer cleanup throws", async () => {
    const f = await fixture({ servingPosture: false });
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      {
        using _open = stub(f.manager, "open", () => {
          throw new Error("observer cleanup failed");
        });
        f.release.resolve();
        await expect(activation).rejects.toThrow("servingPosture");
      }
      expect(f.disposeCalls).toBe(1);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(time.next()).toBe(false);
    } finally {
      await f.close(activation);
    }
  });

  for (const renewBeforeRelease of [false, true]) {
    it(`refuses initialization after a rival takes the lease ${renewBeforeRelease ? "at renewal" : "before renewal"}`, async () => {
      const f = await fixture();
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const activation = f.serving.activate();
      const rival = executionLeaseHolder("did:key:activation-rival");
      try {
        await f.entered.promise;
        releaseExecutionLease(f.engine, { space, holder: f.serving.holder });
        expect(acquireExecutionLease(f.engine, { space, holder: rival }))
          .toBe(true);
        if (renewBeforeRelease) time.tick(5_000);
        f.release.resolve();
        expect(await activation).toBe(false);
        expect(f.serving.active).toBe(false);
        expect(f.stats.waves).toBe(0);
        expect(f.stats.activeSpaces).toBe(0);
        expect(f.stats.lease.lost).toBe(1);
        expect(f.disposeCalls).toBe(1);
        expect(liveExecutionLeaseHolder(f.engine, space)).toBe(rival);
        expect(time.next()).toBe(false);
      } finally {
        await f.close(activation);
      }
    });
  }

  it("refuses factory reads of another user's instance after lease takeover", async () => {
    const f = await fixture();
    const aliceManager = EmulatedStorageManager.connectTo(f.server, {
      as: aliceSigner,
    });
    const alice = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: aliceManager,
    });
    const privateValue = alice.getCellFromLink<number>({
      ...alice.getCell<number>(space, "private-value", undefined)
        .getAsNormalizedFullLink(),
      scope: "user",
    });
    const tx = alice.edit();
    privateValue.withTx(tx).set(7);
    expect((await tx.commit()).error).toBeUndefined();
    const address = {
      id: privateValue.getAsNormalizedFullLink().id,
      scopeKey: resolveScopeKey("user", { principal: aliceSigner.did() }),
    };
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    const rival = executionLeaseHolder("did:key:read-through-rival");
    try {
      const context = await f.entered.promise;
      expect(context.storeReadThrough).toBeDefined();
      expect(context.storeReadThrough!(address)?.doc?.value).toBe(7);
      releaseExecutionLease(f.engine, { space, holder: f.serving.holder });
      expect(acquireExecutionLease(f.engine, { space, holder: rival })).toBe(
        true,
      );
      expect(context.storeReadThrough!(address)).toBeUndefined();
      expect(Engine.read(f.engine, address)?.value).toBe(7);
      f.release.resolve();
      expect(await activation).toBe(false);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBe(rival);
      expect(time.next()).toBe(false);
    } finally {
      try {
        await alice.dispose({ closeStorage: false });
      } finally {
        await aliceManager.close();
      }
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
  });

  it("waits for an initializing runtime's disposal before host close returns", async () => {
    const f = await fixture();
    const aliceManager = EmulatedStorageManager.connectTo(f.server, {
      as: aliceSigner,
    });
    const alice = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: aliceManager,
    });
    const releaseDisposal = defer<void>();
    f.holdDisposal(releaseDisposal.promise);
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const host = new ExecutorHost({
      server: f.server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (_space, context) => f.createRuntime(context),
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await alice.getCell<number>(space, "host-demand", undefined).sync();
      await f.entered.promise;
      closing = host.close().then(() => {
        closed = true;
      });
      time.tick(20_000);
      f.release.resolve();
      await f.disposeEntered.promise;
      expect(closed).toBe(false);
      expect(f.disposeCalls).toBe(1);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeDefined();
      releaseDisposal.resolve();
      await closing;
      expect(closed).toBe(true);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(host.stats().activeSpaces).toBe(0);
      expect(time.next()).toBe(false);
    } finally {
      f.release.resolve();
      releaseDisposal.resolve();
      await closing;
      await host.close();
      try {
        await alice.dispose({ closeStorage: false });
      } finally {
        await aliceManager.close();
      }
      await f.close();
    }
    expect(f.disposeCalls).toBe(1);
  });
});
