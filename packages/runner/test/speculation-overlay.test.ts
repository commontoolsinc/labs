// Server-execution v2 Phase 2: the client speculation overlay
// (speculation.md), end to end against a real memory server, a live
// ExecutorHost (the serving side), and a CLIENT runtime whose flag-ON
// posture is the phase's whole point:
//
// - a client derivation run REDIRECTS its writes into the overlay — the
//   echo renders immediately, the client commits NOTHING for it, and
//   the store's only derivation results are the SpaceServer's
//   derived-class commits (the by-construction removal of the client
//   derivation-commit path);
// - `synced()` never waits on a live overlay entry (the overlay is
//   process-memory only — speculation.md §1);
// - retirement is watermark-driven (speculation.md §4): the pushed
//   derived commit + the replicated watermark doc cover the entry, the
//   overlay empties, and the STORE value renders;
// - client HANDLER writes still commit authored-class (F10 — the
//   Phase-3 interim, protocol.md §1), and UI-binding/imperative writes
//   are untouched authorship;
// - a speculative run's post-commit effects follow the egress rule:
//   external-sink kinds are DROPPED (the client never performs egress
//   under the flag — README §3.5), while the reversible `navigateTo`
//   kind still enacts (optimistic navigation, speculation.md §2).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { SessionRegistry } from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { waitForSettled } from "../src/executor/watermark.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import {
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "../src/speculation/overlay-destination.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager._sharedServer = server;
    return manager;
  }

  private _sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this._sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    sessions: new SessionRegistry({}),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const spaceSigner = await Identity.fromPassphrase("speculation overlay space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "speculation overlay service",
);
const aliceSigner = await Identity.fromPassphrase("speculation overlay alice");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("Phase 2 speculation overlay", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let servingRuntime: Runtime | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: false,
          },
        });
        servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
    onServingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const openClient = () => {
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    // The ambient flag is ON (the host pinned it), so this runtime is a
    // flag-ON CLIENT: no servingPosture, speculation overlay by default.
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  };

  const COUNTER_PATTERN = [
    "import { computed, pattern } from 'commonfabric';",
    "export default pattern<{ n: number }, { total: number }>(",
    "  ({ n }) => ({ total: computed(() => n * 7) }),",
    ");",
  ].join("\n");

  it("a client derivation run diverts to the overlay: instant echo with NO client commit, then watermark-driven retirement to the store value once the server serves (speculation.md §1, §4; the by-construction gate)", async () => {
    // PHASE A — the echo, deterministically BEFORE any serving exists:
    // the client runs the graph locally under the flag; the result
    // renders from the overlay and the store receives no derivation
    // commit at all (there is no code path for one).
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "spec-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "spec-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    // A live reader IS the demand (pull-based laziness): without one
    // the computed never runs anywhere.
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const clientSessions = new Set<string>();
    for (
      const record of Engine.selectCommitsSince(engine, { fromSeq: 0 })
    ) {
      clientSessions.add(record.sessionId);
    }
    const commitsBefore = Engine.selectCommitsSince(engine, {
      fromSeq: 0,
    }).length;

    // The authored input: an imperative (unstamped) write — ordinary
    // authorship, committed as today.
    const editTx = clientRuntime.edit();
    clientArg.withTx(editTx).set({ n: 6 });
    expect((await editTx.commit()).error).toBeUndefined();
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // The ECHO: the client's speculative run rendered 42 with no server
    // executor in existence.
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the speculative echo to render",
    );
    const overlay = clientRuntime.speculationOverlay;
    expect(overlay).toBeDefined();
    expect(overlay!.entryCount(space)).toBeGreaterThanOrEqual(1);

    // (synced() above already proved the overlay never wedges the
    // client durability barrier — it resolved with a live entry
    // outstanding; speculation.md §1.)

    // The by-construction half, pre-serving: the ONLY new commit since
    // the snapshot is the authored argument write. The derivation
    // committed NOTHING.
    const preServing = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(preServing.length).toBe(commitsBefore + 1);
    expect(preServing.every((record) => record.class !== "derived")).toBe(
      true,
    );

    // PHASE B — the authoritative path arrives: stand up the executor;
    // a fresh authored poke activates the space, the SpaceServer
    // derives, ONE derived commit lands + pushes, and the replicated
    // watermark doc covers the entries — retirement.
    onServingRuntime = async (runtime) => {
      const served = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        "spec-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "spec-result",
        served.resultSchema,
      );
      for (let attempt = 0;; attempt++) {
        await argument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, served, argument, result);
        const committed = await tx.commit();
        if (committed.error === undefined) break;
        if (attempt >= 4) {
          throw new Error(
            `serving pattern run failed: ${committed.error.message}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runtime.idle();
    };
    host = newHost();
    const pokeTx = clientRuntime.edit();
    clientArg.withTx(pokeTx).set({ n: 8 });
    expect((await pokeTx.commit()).error).toBeUndefined();
    const pokeSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space activation",
    );
    await waitForSettled(clientRuntime, space, pokeSeq, {
      timeoutMs: 30_000,
    });

    // Retirement (speculation.md §4): the covering watermark retires
    // every entry; the STORE value renders through the same path.
    await waitUntil(
      () => overlay!.entryCount(space) === 0,
      "overlay retirement after settle",
      30_000,
    );
    await waitUntil(
      () => clientResult.key("total").get() === 56,
      "the authoritative value to render",
    );

    // The single-deriver envelope (testing.md §4): every derived-class
    // commit is the lease holder's own — none from any client session.
    const all = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    const derived = all.filter((record) => record.class === "derived");
    expect(derived.length).toBeGreaterThanOrEqual(1);
    for (const record of derived) {
      expect(record.holder).toBeDefined();
      expect(clientSessions.has(record.sessionId)).toBe(false);
    }
    cancelDemand();
  });

  it("client handler writes still commit authored-class (F10: the Phase-3 interim stands)", async () => {
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    const HANDLER_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const bump = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
      ");",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; bump: Stream<unknown> }",
      ">(({ value }) => ({ value, bump: bump({ value }) }));",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: HANDLER_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ value: number }>(
      space,
      "handler-arg",
      undefined,
    );
    const result = clientRuntime.getCell<
      { value: number; bump: unknown }
    >(
      space,
      "handler-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Fire the handler client-side: its write is AUTHORED-class and
    // must land in the store (F10 — the client is still the handler
    // authority until Phase 3).
    const before = Engine.serverSeq(engine);
    result.key("bump").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => {
        const records = Engine.selectCommitsSince(engine, {
          fromSeq: before,
        });
        return records.some((record) => record.class === "authored");
      },
      "an authored-class handler commit",
    );
    // The consequence renders — and it is durable state, not an
    // overlay entry (the store carries the authored write).
    await waitUntil(
      () => {
        const value = argument.key("value").get() as number | undefined;
        return (value ?? 0) >= 1;
      },
      "the handler consequence to be readable",
    );
    cancelDemand();
  });

  it("a speculative run's egress effects are dropped; navigateTo still enacts (the egress rule, README §1/§3.5; speculation.md §2)", async () => {
    // Destination-level pin: no server needed — the allowlist decision
    // is the unit under test.
    const runtime = {
      storageManager: { open: () => ({ replica: {} }) },
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const flushed: string[] = [];
    const effectOf = (kind: string): PostCommitSideEffect => ({
      id: `${kind}:1`,
      kind,
      flush: () => {
        flushed.push(kind);
      },
    });
    const derivationTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(derivationTx, {
      actionId: "spec-test",
      kind: "derivation",
    });
    const owned = destination.deferSealedEffects(derivationTx, [
      effectOf("navigateTo"),
      effectOf("fetch"),
      effectOf("sqlite-query"),
    ]);
    expect(owned).toBe(true);
    await waitUntil(
      () => flushed.length === 1,
      "the navigateTo enactment to flush",
      2_000,
    );
    expect(flushed).toEqual(["navigateTo"]);

    // A handler-kind tx keeps today's inline flush (ownership refused).
    const handlerTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(handlerTx, {
      actionId: "spec-test-handler",
      kind: "event-handler",
    });
    expect(destination.deferSealedEffects(handlerTx, [effectOf("fetch")]))
      .toBe(false);
  });

  it("an effectful builtin reached by client speculation never fires egress: pending renders, zero client fetch calls (README §3.5's never-execute rule)", async () => {
    // Client-only bring-up posture (no serving host): the flag is set
    // explicitly, and the client's fetch stub must never be called.
    const calls: string[] = [];
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify({ leaked: true }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
      experimental: { serverExecution: true },
    });
    const FETCH_PATTERN = [
      "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
      "export default pattern<{ url: string }, { fetch: any }>(",
      "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
      ");",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FETCH_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ url: string }>(
      space,
      "client-fetch-arg",
      undefined,
    );
    const result = clientRuntime.getCell<{ fetch: { pending?: boolean } }>(
      space,
      "client-fetch-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const tx = clientRuntime.edit();
    argument.withTx(tx).set({ url: "https://phase-2.test/never" });
    expect((await tx.commit()).error).toBeUndefined();
    await clientRuntime.idle();
    // Give any (wrong) floating egress every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(calls).toEqual([]);
  });
});
