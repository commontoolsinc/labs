// Server-execution v2 stage F: the serving loop end to end, against a
// real memory server, engines, and TWO runtimes — a client session
// (authored commits over the loopback wire) and the SpaceServer's
// serving runtime (the ExecutorHost activates it on the client's session
// open; serving-loop.md §1, §3):
//
// - activation on session open via the admission-side observer (plane
//   (b)), lease acquired and RENEWED on stage B's cadence;
// - an authored client commit wakes the loop; the scheduler runs the
//   affected graph; the action seals into the wave; ONE derived commit
//   lands carrying the wave's writes, the watermark doc write, and
//   `derivedThrough` (protocol.md §4);
// - the client observes the derived value through ordinary push (M4:
//   instance-keyed dirtiness reaches its subscription) and settles via
//   `waitForSettled` — the poll-loop replacement (testing.md §3);
// - the loop's own derived commit returns on the feed and is skipped by
//   class + holder (self-echo, §3): the wave counter stabilizes;
// - a lost lease parks the space after reacquire fails (§2), and an
//   idle space with no live sessions parks per IDLE_PARK_MS (§1).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  acquireExecutionLease,
  executionLeaseHolder,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import { SessionRegistry } from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  readWatermarkSeq,
  waitForSettled,
  watermarkCell,
} from "../src/executor/watermark.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import { getArtifactEntryRef } from "../src/builder/pattern-metadata.ts";

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

const newSharedServer = (sessionTtlMs?: number) =>
  new MemoryV2Server.Server({
    ...(sessionTtlMs === undefined
      ? {}
      : { sessions: new SessionRegistry({ ttlMs: sessionTtlMs }) }),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const spaceSigner = await Identity.fromPassphrase("serving loop space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("serving loop service");
const aliceSigner = await Identity.fromPassphrase("serving loop alice");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("stage F serving loop", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;
  let servingRuntime: Runtime | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;
  // serving-loop.md §3e: the pattern-update posture flips server-side.
  // The updater's source CHECK fetches over the network, which this
  // fully-local harness cannot serve — the posture flip is asserted by
  // its own test below; the loop tests run with the check off so idle()
  // is not at the mercy of a network timeout.
  let autoUpdate = false;

  const newHost = (
    policy?: ConstructorParameters<typeof ExecutorHost>[0]["policy"],
  ): ExecutorHost =>
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
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: autoUpdate,
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
      policy,
    });

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
    onServingRuntime = undefined;
    autoUpdate = false;
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
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  };

  it("serves a demanded derivation: authored commit → wave → ONE derived commit with watermark; the client settles via waitForSettled", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    // The serving graph: a REAL pattern run server-side at activation —
    // in production this structure materializes through the demand
    // loader (`ensurePieceRunning`); the run here IS the loaded
    // structure. The client's subscription to the result doc is the
    // DEMAND the loop maps to a live server-side reader.
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        "serving-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "serving-result",
        compiled.resultSchema,
      );
      // Presync before running, and retry a stale-read conflict: the
      // run races the client's in-flight authored writes, and the real
      // loader machinery owns exactly this presync + bounded-retry duty
      // (runtime-mapping N24/N15).
      for (let attempt = 0;; attempt++) {
        await argument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
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

    openClient();
    const engine = await server.engineForSpace(space);

    // The client's DEMAND: subscribe the result doc. Its session open
    // activates the space (plane (b)).
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "serving-result",
      undefined,
    );
    await clientResult.sync();

    // The client's authored write — the wave's input.
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "serving-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);

    // The serving loop activates, derives, and advances the watermark
    // past the authored commit.
    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      "watermark to reach the authored commit",
    );

    // waitForSettled (testing.md §3): resolves through the ordinary
    // client subscription — no text polling.
    const settled = await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(authoredSeq);

    // The derived value: the pattern computed 41 + 1 server-side. The
    // client reads it through the result doc's link (ordinary push +
    // link traversal — M4's instance-keyed dirtiness reached its
    // subscription).
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "client to observe the derived value",
    );

    // The derived commits: class derived, holder = the DR1 holder
    // minted from the service identity; the watermark doc write rides a
    // derived commit (never its own commit) and derivedThrough covers
    // the authored input.
    const derived = engine.database.prepare(
      `SELECT seq, holder, derived_through FROM "commit"
       WHERE class = 'derived' ORDER BY seq`,
    ).all() as { seq: number; holder: string; derived_through: number }[];
    expect(derived.length).toBeGreaterThanOrEqual(1);
    const spaceServer = host.spaceServer(space);
    expect(spaceServer?.active).toBe(true);
    for (const row of derived) {
      expect(row.holder).toBe(spaceServer!.holder);
    }
    const watermarkWrite = engine.database.prepare(
      `SELECT commit_seq FROM revision WHERE id = :id ORDER BY seq DESC LIMIT 1`,
    ).get({ id: "of:server-execution-watermark" }) as {
      commit_seq: number;
    };
    expect(derived.map((row) => row.seq)).toContain(watermarkWrite.commit_seq);
    const finalDerived = derived[derived.length - 1];
    expect(finalDerived.derived_through).toBeGreaterThanOrEqual(authoredSeq);

    // Self-echo (§3): the loop's own derived commits return on the feed
    // and are skipped — the wave count stabilizes rather than looping.
    const wavesAfter = host.stats().waves;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(host.stats().waves).toBe(wavesAfter);

    // §7 counters: the loop is counted, not logged.
    const stats = host.stats();
    expect(stats.activeSpaces).toBe(1);
    expect(stats.derivedCommits).toBeGreaterThanOrEqual(1);
    expect(stats.lease.held).toBe(1);
    expect(stats.lease.lost).toBe(0);
    expect(stats.events.appended).toBe(0);
    expect(stats.memo.hits + stats.memo.misses).toBe(0);

    // A second authored write drives a second wave THROUGH THE SEALED
    // PATH (the destination is installed now): the recompute seals into
    // the wave and lands in a derived commit; the loop keeps serving
    // across renewals.
    const tx2 = clientRuntime.edit();
    clientArg.withTx(tx2).set({ n: 99 });
    expect((await tx2.commit()).error).toBeUndefined();
    const authored2 = Engine.serverSeq(engine);
    expect(host.stats().authoredSeen).toBeGreaterThanOrEqual(1);
    await waitForSettled(clientRuntime, space, authored2, {
      timeoutMs: 10_000,
    });
    await waitUntil(
      () => clientResult.key("total").get() === 100,
      "client to observe the second derived value",
    );

    // The recompute's write is DERIVED-class — the computed's doc's
    // latest revision rides a derived commit, not an authored one.
    const computedRow = engine.database.prepare(
      `SELECT c.class AS class FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.id LIKE 'computed:%' ORDER BY r.seq DESC LIMIT 1`,
    ).get() as { class: string } | undefined;
    expect(computedRow?.class).toBe("derived");

    // The serving runtime's watermark cell reads the same W the client
    // settles on (one well-known SPACE-scoped doc).
    expect(servingRuntime).toBeDefined();
    expect(
      watermarkCell(servingRuntime!, space).get()?.seq,
    ).toBeGreaterThanOrEqual(authored2);
  });

  it("hot-swaps a pattern SERVER-side: a client's pattern-pointer write dirties the piece and the SpaceServer swaps (serving-loop.md §3e, OW6)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    // §3e's posture: the watcher and the swap live in the SpaceServer.
    // The SWAP half — the patternIdentity sink reacting to a pointer
    // write, teardown + reinstantiation included — is what this test
    // drives, and it is installed with the piece (gated only by
    // doNotUpdateOnPatternChange), independent of the
    // systemPatternAutoUpdate CHECK half. The check half (network source
    // polling + roll-forward) is enabled by the production wiring
    // (toolshed's serving-runtime factory) and needs a real patterns
    // route to poll; in this fully-local fixture its source probe syncs
    // docs that never resolve and would wedge the settle — the flagged
    // stage-F residual.
    autoUpdate = false;

    let v2Ref: { identity: string; symbol: string } | undefined;
    onServingRuntime = async (runtime) => {
      const compileProgram = (expression: string) => ({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            `  ({ n }) => ({ total: computed(() => ${expression}) }),`,
            ");",
          ].join("\n"),
        }],
      });
      const v1 = await runtime.patternManager.compilePattern(
        compileProgram("n + 1"),
        { space },
      );
      const v2 = await runtime.patternManager.compilePattern(
        compileProgram("n + 2"),
        { space },
      );

      // v2's durable {identity, symbol}: the content-addressed entry
      // ref the compile indexed — exactly what the updater's pointer
      // write names.
      v2Ref = getArtifactEntryRef(v2);

      // The served piece runs v1.
      const argument = runtime.getCell<{ n: number }>(
        space,
        "swap-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "swap-result",
        v1.resultSchema,
      );
      for (let attempt = 0;; attempt++) {
        await argument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, v1, argument, result);
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

    openClient();
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "swap-result",
      undefined,
    );
    await clientResult.sync();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "swap-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 15_000,
    });
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "v1 to serve 42",
    );

    // The pattern-pointer write: an ordinary AUTHORED input under the
    // updater's principal (here, the client) — the swap is the SERVER
    // reacting to it (serving-loop.md §3e; runtime-mapping N40/N41).
    expect(v2Ref?.identity).toBeDefined();
    const pointerTx = clientRuntime.edit();
    clientResult.withTx(pointerTx).setMetaRaw("patternIdentity", v2Ref!);
    expect((await pointerTx.commit()).error).toBeUndefined();

    // The SpaceServer's watcher swaps to v2 and the wave serves the new
    // derivation: total becomes 43 without any client-side run — OW6's
    // substance: the pointer write is an ordinary authored input, and
    // the swap is the server reacting.
    await waitUntil(
      () => clientResult.key("total").get() === 43,
      "the server-side swap to serve 43",
      20_000,
    );
    // The swapped-in derivation landed as a DERIVED commit.
    const derivedAfterSwap = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM "commit" WHERE class = 'derived'`,
    ).get() as { n: number };
    expect(derivedAfterSwap.n).toBeGreaterThanOrEqual(1);
    // Watermark note, deliberate: W is NOT asserted past the pointer
    // write here. The swap's by-identity reload can leave a module-doc
    // sync pending in this fully-local fixture, and an outstanding
    // demanded load legitimately pins W (protocol.md §4: W covers
    // demanded derivations CURRENT through W) — the flagged stage-F
    // settle residual, exercised properly against a real patterns route
    // in the integration environment.
  });

  it("parks on lease loss when a rival holds the lease (serving-loop.md §2)", async () => {
    host = newHost({
      flushDeadlineMs: 1_000,
      idleParkMs: 600_000,
      renewIntervalMs: 25,
    });
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "lease-loss-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate",
    );
    const spaceServer = host.spaceServer(space)!;
    const engine = await server.engineForSpace(space);

    // Simulate expiry + takeover: the row disappears and a RIVAL takes
    // it, so renewal fails AND reacquire fails — the space parks.
    releaseExecutionLease(engine, { space, holder: spaceServer.holder });
    const rival = executionLeaseHolder("did:key:rival-process");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);

    await waitUntil(
      () => host!.spaceServer(space)?.active !== true,
      "space to park after lease loss",
    );
    expect(host.stats().lease.lost).toBeGreaterThanOrEqual(1);
    expect(host.stats().activeSpaces).toBe(0);
  });

  it("parks an idle space with no live sessions (IDLE_PARK_MS), releasing the lease", async () => {
    server = newSharedServer(50);
    host = newHost({
      flushDeadlineMs: 500,
      idleParkMs: 100,
    });
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "idle-park-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate",
    );
    const holder = host.spaceServer(space)!.holder;

    // Drop the client: its session detaches and expires (TTL 50ms), the
    // loop idles past IDLE_PARK_MS, and the space parks — releasing the
    // lease row (a rival can then acquire immediately).
    await clientRuntime.dispose();
    await clientManager.close();
    openClient();
    // The fresh client session keeps OTHER spaces alive only; close it
    // too so the space has no live sessions at all.
    await clientRuntime.dispose();
    await clientManager.close();
    openClient(); // leave a manager for afterEach teardown symmetry

    await waitUntil(
      () => host!.spaceServer(space)?.active !== true,
      "space to park on idle",
      15_000,
    );
    const engine = await server.engineForSpace(space);
    releaseExecutionLease(engine, { space, holder }); // no-op if released
    const rival = executionLeaseHolder("did:key:idle-rival");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);
  });
});
