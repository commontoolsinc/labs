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
  liveExecutionLeaseHolder,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { markEffectCompletion } from "../src/executor/effect-completion.ts";
import { decodeMemoryBoundary, resolveScopeKey } from "@commonfabric/memory/v2";
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
  // Delegate to the base connectTo (shared-harness extraction, CT-1962):
  // `new this` gives back this subclass, and the base clears server
  // ownership so closing this manager never closes the shared server.
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }

  /** Test seam for the renew-blip interleave: when set, the serving
   * loop's settle hangs at its `inputSynced` barrier until the gate
   * resolves — holding an open (sealed, uncommitted) wave across a
   * lease tenure bump, deterministically. Undefined everywhere else. */
  settleGate: Promise<void> | undefined;

  override async inputSynced(): Promise<void> {
    await super.inputSynced();
    if (this.settleGate !== undefined) await this.settleGate;
  }
}

const newSharedServer = (
  options: { sessionTtlMs?: number; subscriptionRefreshDelayMs?: number } = {},
) =>
  new MemoryV2Server.Server({
    ...(options.sessionTtlMs === undefined
      ? {}
      : { sessions: new SessionRegistry({ ttlMs: options.sessionTtlMs }) }),
    subscriptionRefreshDelayMs: options.subscriptionRefreshDelayMs ?? 0,
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
  /** Stage G: the serving runtime's injected fetch (egress stub) —
   * effectful builtins served by the loop call THIS, never the network. */
  let servingFetch:
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;
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
          ...(servingFetch !== undefined ? { fetch: servingFetch } : {}),
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
    servingFetch = undefined;
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
    // Structure-load failures are SURFACED (serving-loop.md §1's
    // counted-and-logged posture reaches the §7 block, not a private
    // field): zero here — the demanded structure loaded.
    expect(stats.structureLoadFailures).toBe(0);
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
    // W-soundness, bound STRICTLY (protocol.md §4): with the
    // subscriptions established, "settled" must mean the demanded
    // derivation is ALREADY current — the derived value and the
    // watermark ride one wave commit and one push frame, so the read
    // here is synchronous, no waiting. (This is the assertion that
    // catches a loop advancing W before the derivation ran.)
    expect(clientResult.key("total").get()).toBe(100);
    // And the store agrees at the same instant: the derivation is
    // durably committed at-or-below the settled watermark.
    const settledDerived = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.id LIKE 'computed:%' AND c.class = 'derived'`,
    ).get() as { n: number };
    expect(settledDerived.n).toBeGreaterThanOrEqual(1);

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

  it("holds W until loopback frames deliver at a REAL refresh cadence: the settle's server.idle() drain is load-bearing (protocol.md §4)", async () => {
    // The other tests run `subscriptionRefreshDelayMs: 0`, which masks
    // the settle's `server.idle()` drain: the refresh timer fires
    // before the settle's yield and delivers the loopback frames
    // anyway. Here the refresh delay is set ABOVE the flush deadline
    // (the production default, 5 ms, exhibits the same race — this
    // margin makes the probe deterministic on slow CI), so frame
    // delivery inside the settle happens ONLY through the explicit
    // drain. Remove `await this.#options.server.idle()` from
    // SpaceServer's settle and this test fails: the settle declares
    // quiescence before the authored commit's dirtiness ever reaches
    // the serving scheduler, W advances over the undelivered input,
    // and the strict settled ⇒ current assertion below reads a stale
    // derived value.
    server = newSharedServer({ subscriptionRefreshDelayMs: 400 });
    host = newHost({ flushDeadlineMs: 300, idleParkMs: 600_000 });

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
        "drain-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "drain-result",
        compiled.resultSchema,
      );
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

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "drain-result",
      undefined,
    );
    await clientResult.sync();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "drain-arg",
      undefined,
    );
    await clientArg.sync();

    // Phase 1 — prime: first authored write, settle, observe the
    // derived value. This also establishes the client's watermark-doc
    // watch, so phase 2's frames arrive on a LIVE subscription (the
    // strict assertion's precondition, as in the first test).
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "client to observe the first derived value",
    );

    // Phase 2 — the strict W-soundness probe (protocol.md §4): with
    // the subscriptions live, "settled" must mean the demanded
    // derivation is ALREADY current — the derived value and the
    // watermark ride one wave commit and one push frame, so this read
    // is synchronous. Under the mutation (settle drain removed) the
    // wave advances W without the recompute, the flush carries the
    // watermark upsert alone, and this read sees the STALE total.
    const tx2 = clientRuntime.edit();
    clientArg.withTx(tx2).set({ n: 99 });
    expect((await tx2.commit()).error).toBeUndefined();
    const authored2 = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authored2, {
      timeoutMs: 10_000,
    });
    expect(clientResult.key("total").get()).toBe(100);
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
    // Baseline BEFORE the swap: the post-swap assertions below must
    // pin the SWAPPED derivation's own commit, not be satisfiable by
    // v1's pre-swap derived commits.
    const preSwapHead = Engine.serverSeq(engine);
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
    // The SWAPPED derivation's own commit: derived-class commits landed
    // AFTER the pre-swap baseline, under the loop's own holder — v1's
    // earlier derived commits cannot satisfy this.
    const swapDerived = engine.database.prepare(
      `SELECT seq, holder FROM "commit"
       WHERE class = 'derived' AND seq > :preSwapHead ORDER BY seq`,
    ).all({ preSwapHead }) as { seq: number; holder: string }[];
    expect(swapDerived.length).toBeGreaterThanOrEqual(1);
    for (const row of swapDerived) {
      expect(row.holder).toBe(host.spaceServer(space)!.holder);
    }
    // And the value the client observed (43) is the NEWEST computed
    // revision, riding one of those post-swap derived commits.
    const latestComputed = engine.database.prepare(
      `SELECT c.class AS class, c.seq AS seq FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.id LIKE 'computed:%' ORDER BY r.seq DESC LIMIT 1`,
    ).get() as { class: string; seq: number } | undefined;
    expect(latestComputed?.class).toBe("derived");
    expect(latestComputed!.seq).toBeGreaterThan(preSwapHead);
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

  it("parks on a renew-blip mid-wave abort: reacquire succeeds, the aborted wave's space still parks and W does not move (serving-loop.md §2)", async () => {
    // The renew-blip interleave, end to end: (1) a wave opens (a seal
    // captures the CURRENT lease tenure); (2) the lease row vanishes
    // (expiry analogue) with NO rival, so the next renew tick FAILS and
    // the same-process reacquire SUCCEEDS — tenure bumps while the
    // sealed wave is still uncommitted; (3) the wave reaches its commit
    // step under the bumped tenure and aborts, its sealed writes
    // withdrawn. The pinned behavior: the space PARKS on that abort.
    // The pre-fix loop continued instead — and since nothing re-arms a
    // withdrawn derivation's producer (no revert consumer; inputs
    // unchanged) while #coverageHead had already claimed the batch, the
    // next cycle minted a watermark-only advance claiming work that
    // never re-ran. Deterministic mid-wave hold: the test manager's
    // settleGate hangs the settle's inputSynced barrier, keeping the
    // sealed wave open across the blip without any product-code hook.
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      renewIntervalMs: 25,
    });
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "renew-blip-input",
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
    // Let the activation-triggered cycle finish (its watermark-only
    // advance claims the authored input) so the loop sits in
    // wait-for-input — not mid-settle — before the gate closes.
    const authoredSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      "the activation cycle to settle",
    );

    // Close the gate, then open a wave: a stamped tx on the SERVING
    // runtime seals into the wave (capturing the current tenure); its
    // commit step cannot run until the settle passes the gated
    // inputSynced barrier.
    const manager = servingRuntime!
      .storageManager as SharedServerStorageManager;
    const gate = Promise.withResolvers<void>();
    manager.settleGate = gate.promise;
    const probeCell = servingRuntime!.getCell<{ n: number }>(
      space,
      "renew-blip-probe",
      undefined,
    );
    await probeCell.sync();
    const probeTx = servingRuntime!.edit();
    stampWaveRunContext(probeTx, {
      actionId: "test/renew-blip-probe",
      kind: "derivation",
    });
    probeCell.withTx(probeTx).set({ n: 1 });
    // Resolves at SEAL (the wave holds the store commit).
    expect((await probeTx.commit()).error).toBeUndefined();

    // The blip: the row vanishes with NO rival. The next renew tick
    // fails (tenure ends) and the same-process reacquire succeeds
    // (tenure bumps) — while the sealed wave is still gated open.
    releaseExecutionLease(engine, { space, holder: spaceServer.holder });
    await waitUntil(
      () => host!.stats().lease.lost >= 1,
      "the renew tick to fail once",
    );
    await waitUntil(
      () => liveExecutionLeaseHolder(engine, space) === spaceServer.holder,
      "the blip reacquire to restore the row",
    );
    const watermarkBefore = readWatermarkSeq(engine);

    // Open the gate: the settle resumes, the wave reaches its commit
    // step under the bumped tenure and aborts — and the space PARKS
    // (the pre-fix loop stayed active here, which is what this
    // waitUntil pins against).
    gate.resolve();
    await waitUntil(
      () => host!.spaceServer(space)?.active !== true,
      "space to park on the lease-lost wave abort",
    );
    manager.settleGate = undefined;
    // Soundness: no watermark movement rode the aborted wave, and no
    // continued loop minted a watermark-only advance after it.
    expect(readWatermarkSeq(engine)).toBe(watermarkBefore);
    expect(host.stats().activeSpaces).toBe(0);
    expect(host.stats().lease.lost).toBeGreaterThanOrEqual(1);
  });

  it("parks on a serving-loop failure instead of leaving a zombie holding the lease (thread r3731191431)", async () => {
    // A policy whose flushDeadlineMs getter can be made to throw: the
    // loop reads it once per wave cycle, so flipping `blowUp` makes the
    // NEXT cycle fail inside #waveCycle — a stand-in for any transient
    // loop failure. The pinned behavior: the loop's failure PARKS the
    // space (lease released, host hooks can recover); the pre-fix loop
    // died silently while the space stayed active and the renew timer
    // kept the lease alive forever — serving nothing, blocking every
    // successor.
    let blowUp = false;
    host = newHost(
      {
        idleParkMs: 600_000,
        renewIntervalMs: 25,
        get flushDeadlineMs(): number {
          if (blowUp) throw new Error("induced loop failure");
          return 1_000;
        },
      } as ConstructorParameters<typeof ExecutorHost>[0]["policy"],
    );
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "loop-failure-input",
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

    // Fail the next cycle and wake the loop.
    blowUp = true;
    spaceServer.noteDemandChanged();

    await waitUntil(
      () => host!.spaceServer(space)?.active !== true,
      "space to park after the loop failure",
    );
    // The distinguishing observation: the pre-fix loop died with the
    // space still ACTIVE (the waitUntil above would time out) and the
    // renew timer alive. whenParked resolves only after this tenure's
    // park path completed — renew stopped, runtime disposed, lease
    // released.
    await spaceServer.whenParked;

    // What follows the failure park is the host's DESIGNED recovery arm:
    // the still-open client session is live demand, so the host
    // re-activates — and, with this policy failing every cycle, parks
    // and recovers again; with #5729's event-loop-turn frame delivery
    // the re-acquire outruns any released-gap probe. Close the host to
    // end recovery, then pin the no-zombie contract: nothing is left
    // renewing, so the lease frees for a rival. (Poll rather than probe
    // once: close() does not await a self-initiated park already in
    // flight, so the final tenure's release can land a beat later.)
    await host.close();
    const engine = await server.engineForSpace(space);
    const rival = executionLeaseHolder("did:key:loop-failure-rival");
    await waitUntil(
      () => acquireExecutionLease(engine, { space, holder: rival }),
      "the released lease to become acquirable by a rival",
    );
    releaseExecutionLease(engine, { space, holder: rival });
  });

  it("close() during a mid-flight activation leaves no serving zombie: the activated space parks and the lease frees (thread r3731191438)", async () => {
    host = newHost({ flushDeadlineMs: 1_000, idleParkMs: 600_000 });
    // Initiate close WHILE the activation is mid-flight (createRuntime
    // awaits this hook, deterministically interleaving the two).
    let closeStarted: Promise<void> | undefined;
    onServingRuntime = () => {
      closeStarted = host!.close();
      return Promise.resolve();
    };
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "close-race-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await waitUntil(
      () => closeStarted !== undefined,
      "the activation to reach the close-race hook",
    );
    await closeStarted;

    // After close() resolves: nothing serves this space, and the lease
    // row is free for a successor process — the pre-fix close returned
    // while the activation completed behind it, leaving an active
    // SpaceServer renewing a lease nobody could take.
    expect(host.spaceServer(space)?.active ?? false).toBe(false);
    const engine = await server.engineForSpace(space);
    const rival = executionLeaseHolder("did:key:close-race-rival");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);
    releaseExecutionLease(engine, { space, holder: rival });
  });

  it("a service-principal session alone is not demand: session-open activation is gated like the admission path (thread r3731191525)", async () => {
    host = newHost({ flushDeadlineMs: 1_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();

    // A session under the SERVICE identity (a loopback plane, not a
    // client): its open must NOT activate the space — the loop would
    // hold a runtime and the lease with no client demanding anything.
    const serviceManager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    const serviceRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: serviceManager,
    });
    try {
      const probe = serviceRuntime.getCell<{ value: number }>(
        space,
        "service-session-probe",
        undefined,
      );
      await probe.sync();
      // Give any (wrong) activation a beat to happen.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(host.spaceServer(space)).toBeUndefined();

      // A real CLIENT session still activates.
      openClient();
      const clientProbe = clientRuntime.getCell<{ value: number }>(
        space,
        "service-session-probe",
        undefined,
      );
      await clientProbe.sync();
      await waitUntil(
        () => host!.spaceServer(space)?.active === true,
        "a client session to activate the space",
      );
    } finally {
      await serviceRuntime.dispose();
      await serviceManager.close();
    }
  });

  it("parks an idle space with no live sessions (IDLE_PARK_MS), releasing the lease", async () => {
    server = newSharedServer({ sessionTtlMs: 50 });
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

  it("serves an effectful node behind request-hash memoization: miss fires ONCE via the outbox; recovery memo-hits; retries are input-driven (serving-loop.md §4–§6; T7.Q5, T10.Q4, OW7)", async () => {
    // The egress stub: the serving loop performs the effect (README
    // §3.8's server half); calls are counted per URL, and one URL
    // fails deterministically — the OW7 journey's failure leg.
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes("/fails")) {
        return Promise.reject(new Error("stubbed egress failure"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { fetch: any }>(",
            "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "effect-arg",
        undefined,
      );
      const result = runtime.getCell<{ fetch: unknown }>(
        space,
        "effect-result",
        compiled.resultSchema,
      );
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
    const clientResult = clientRuntime.getCell<
      { fetch: { result?: unknown; error?: unknown } }
    >(
      space,
      "effect-result",
      undefined,
    );
    await clientResult.sync();

    // Wait for ACTIVATION before writing the url: the harness's
    // factory-time pattern run predates the seal destination (the
    // stage-F "the run here IS the loaded structure" trick), so a url
    // visible at factory time would fire OUTSIDE the outbox. With the
    // url arriving as an authored wave input, the fetch node's miss
    // runs the stage-G path: seal -> defer -> outbox -> completion.
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate before the url write",
    );
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "effect-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ url: "https://stage-g.test/one" });
    expect((await tx.commit()).error).toBeUndefined();

    // The miss fires exactly once; the completion commits its OWN
    // derived-class commit and the next wave serves the value — the
    // client observes it through ordinary push.
    // 30 s here and on this step's two later observation waits: this
    // file is deliberately real-clock, and under load the wave cycle
    // degrades to deadline-paced waves (flushDeadlineMs 5_000), so a
    // multi-wave leg legitimately overruns 15 s while still
    // progressing (the soak flake signature: rare timeout reds, zero
    // double-egress). Matches the recovery leg's 30 s "loaded box"
    // budget below.
    await waitUntil(
      () =>
        (clientResult.key("fetch").key("result").get() as {
          from?: string;
        } | undefined)?.from === "https://stage-g.test/one",
      "client to observe the served fetch result",
      30_000,
    );
    expect(calls.filter((url) => url.endsWith("/one")).length).toBe(1);
    const stats1 = host.stats();
    // At least one miss/queued/completed (>=, not ===: a stale action
    // re-run may legitimately re-ADMIT the key — the claim-time
    // result-present guard makes the re-admit's flush a no-op, so the
    // EXTERNAL call count above is the exactly-once being pinned).
    expect(stats1.memo.misses).toBeGreaterThanOrEqual(1);
    expect(stats1.outbox.queued).toBeGreaterThanOrEqual(1);
    expect(stats1.outbox.completed).toBeGreaterThanOrEqual(1);
    // The post-completion re-run of the fetch action (its result-cell
    // dirtiness re-arms it in the next wave) resolves from the stored
    // key: the SS4 memo hit, counted live.
    await waitUntil(
      () => host!.stats().memo.hits >= 1,
      "the post-completion re-run to memo-hit",
    );

    // Crash/park equivalence (T10.Q4, §6 step 3): park, then
    // re-activate on fresh input — the recovered runtime re-runs the
    // action against COMMITTED state; a first evaluation that sees the
    // stored requestHash memo-hits and re-fires nothing, and one that
    // raced its cell sync re-misses (the accepted at-least-once
    // duplicate). The assertions below pin exactly that contract.
    await host.spaceServer(space)!.park("test-recovery");
    await waitUntil(
      () => host!.spaceServer(space)?.active !== true,
      "space to park for the recovery leg",
    );
    const poke = clientRuntime.getCell<{ n: number }>(
      space,
      "effect-poke",
      undefined,
    );
    const pokeTx = clientRuntime.edit();
    poke.withTx(pokeTx).set({ n: 1 });
    expect((await pokeTx.commit()).error).toBeUndefined();
    // Captured AT the poke commit: a read after re-activation could
    // capture the recovered loop's own derived commit's seq, which W
    // never covers (self-echo is not coverage-owed input — the
    // anti-storm rule; serving-loop.md §3).
    const pokeSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to re-activate",
    );
    // Let the recovered loop claim the poke input before measuring —
    // the recovery churn (structure re-load, a possible re-miss) must
    // be over, or the bound below races it. Generous: recovery on a
    // loaded box legitimately takes several waves.
    await waitUntil(
      () => readWatermarkSeq(engine) >= pokeSeq,
      "the recovered loop to claim the poke input",
      30_000,
    );
    // T10.Q4's ruled contract across recovery: memo hits suppress
    // re-firing COMPLETED effects, and the external call MAY duplicate
    // (at-least-once across crash/park — RULED and accepted; the
    // fired-marker was considered and REJECTED; a recovered runtime
    // whose first evaluation raced its cell sync re-misses once). The
    // pin is therefore BOUNDED, never unbounded growth — the
    // no-timer-retry property is pinned deterministically on the
    // failure leg below.
    expect(calls.filter((url) => url.endsWith("/one")).length)
      .toBeLessThanOrEqual(2);

    // OW7's failure leg: new inputs → new key → the miss fires and
    // FAILS; the failure commits an error-shaped RESULT with the key
    // (§4: retries are input-driven, never timer loops), so the call
    // count stays put until the inputs change again.
    const failTx = clientRuntime.edit();
    clientArg.withTx(failTx).set({ url: "https://stage-g.test/fails" });
    expect((await failTx.commit()).error).toBeUndefined();
    await waitUntil(
      () => clientResult.key("fetch").key("error").get() !== undefined,
      "client to observe the error-shaped result",
      30_000,
    );
    expect(calls.filter((url) => url.endsWith("/fails")).length).toBe(1);
    // No timer retry, pinned DETERMINISTICALLY (round-2 thread 10): a
    // fixed wall-clock sleep proves nothing about a forbidden retry
    // armed on a longer interval or delayed by scheduling. Drive the
    // loop through additional full waves instead — input-driven
    // activity on an UNRELATED doc, each claimed by the watermark —
    // and assert the failed key still did not re-fire after the loop
    // demonstrably cycled several times.
    const retryProbe = clientRuntime.getCell<{ n: number }>(
      space,
      "no-timer-retry-probe",
      undefined,
    );
    for (let i = 1; i <= 3; i++) {
      // Head captured BEFORE the probe commit: a post-commit read can
      // capture the loop's own derived commit's seq, which W never
      // covers (self-echo is not coverage-owed input — the same trap
      // the recovery leg's poke documents). The probe's authored seq
      // is > seqBefore, and the only coverage-owed input in this quiet
      // phase, so W > seqBefore proves the loop claimed it.
      const seqBefore = Engine.serverSeq(engine);
      const probeTx = clientRuntime.edit();
      retryProbe.withTx(probeTx).set({ n: i });
      expect((await probeTx.commit()).error).toBeUndefined();
      await waitUntil(
        () => readWatermarkSeq(engine) > seqBefore,
        `the loop to claim no-timer-retry probe ${i}`,
        30_000,
      );
    }
    expect(calls.filter((url) => url.endsWith("/fails")).length).toBe(1);

    // The input-driven retry: a THIRD url re-fires (fresh key), and the
    // effectful node recovers.
    const retryTx = clientRuntime.edit();
    clientArg.withTx(retryTx).set({ url: "https://stage-g.test/two" });
    expect((await retryTx.commit()).error).toBeUndefined();
    await waitUntil(
      () =>
        (clientResult.key("fetch").key("result").get() as {
          from?: string;
        } | undefined)?.from === "https://stage-g.test/two",
      "client to observe the retried fetch result",
      30_000,
    );
    expect(calls.filter((url) => url.endsWith("/two")).length).toBe(1);
    // FINAL stability re-check, after every later leg's waves and
    // writebacks have run: the steady-state legs stay exactly-once (a
    // broken memo-hit rule or a timer retry landing late would surface
    // here), and the recovery leg stays within its at-least-once bound.
    expect(calls.filter((url) => url.endsWith("/one")).length)
      .toBeLessThanOrEqual(2);
    expect(calls.filter((url) => url.endsWith("/fails")).length).toBe(1);
  });

  it("survives the deterministic A→B→A input cycle: the returning input re-fires instead of starving on a dead in-flight entry (completion-visibility F1a)", async () => {
    // The no-race wedge this pins closed: pre-F1a, a served effect's
    // completion resolved its verdict inline but the serving replica's
    // accept PARKED awaiting a catch-up marker that engine-plane commits
    // never stage — so the whenApplied retirement barrier never
    // resolved and the effect's in-flight entry never retired. An input
    // cycle A→B→A re-admits key A while the DEAD entry still holds it:
    // the re-admit dedupes forever, no effect fires, and the client's
    // value never arrives (starvation, no timing required).
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { fetch: any }>(",
            "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "cycle-arg",
        undefined,
      );
      const result = runtime.getCell<{ fetch: unknown }>(
        space,
        "cycle-result",
        compiled.resultSchema,
      );
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
    const clientResult = clientRuntime.getCell<
      { fetch: { result?: unknown; error?: unknown } }
    >(
      space,
      "cycle-result",
      undefined,
    );
    await clientResult.sync();
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate before the url write",
    );
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "cycle-arg",
      undefined,
    );
    await clientArg.sync();
    const observes = (leg: string) =>
      (clientResult.key("fetch").key("result").get() as {
        from?: string;
      } | undefined)?.from === `https://stage-g.test/${leg}`;
    const writeUrl = async (leg: string) => {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ url: `https://stage-g.test/${leg}` });
      expect((await tx.commit()).error).toBeUndefined();
    };

    // A: served and observed (30 s legs: real-clock file — under load
    // the wave cycle degrades to deadline-paced waves, see the memo
    // test's budget note).
    await writeUrl("a");
    await waitUntil(() => observes("a"), "client to observe leg A", 30_000);
    // B: a fresh key, served and observed; the memo state now holds B.
    await writeUrl("b");
    await waitUntil(() => observes("b"), "client to observe leg B", 30_000);
    // Back to A — the primary regression pin: at the pre-fix tree this
    // starves (the re-admit of key A dedupes against the never-retired
    // first entry; no effect fires; this wait times out).
    await writeUrl("a");
    await waitUntil(() => observes("a"), "client to re-observe leg A", 30_000);

    // The returning leg is a genuine re-miss (B's completion overwrote
    // the stored request hash), so A fired at least twice — the lower
    // bound IS the regression pin (a starving re-admit leaves it at 1)
    // — and B at least once. The upper bounds carry the same
    // at-least-once allowance the memo test's recovery leg documents
    // (round-2 thread 19): under load-degraded deadline-paced waves a
    // stale evaluation may legitimately re-miss ONCE per leg before
    // the completion becomes readable, so exact counts flake; bounded,
    // never zero (starvation) and never runaway.
    const aCalls = calls.filter((url) => url.endsWith("/a")).length;
    const bCalls = calls.filter((url) => url.endsWith("/b")).length;
    expect(aCalls).toBeGreaterThanOrEqual(2);
    expect(aCalls).toBeLessThanOrEqual(3);
    expect(bCalls).toBeGreaterThanOrEqual(1);
    expect(bCalls).toBeLessThanOrEqual(2);

    // And the served value STAYS: no post-arrival destroyer wipe (the
    // F2 half — a torn hash would wipe it on the next wave). The
    // scheduler settles, then the value is still there.
    await waitUntil(
      () => host!.stats().memo.inflight === 0,
      "in-flight effects to drain after the cycle",
      15_000,
    );
    expect(observes("a")).toBe(true);
  });

  it("serves BOTH result cells when two DISTINCT nodes issue byte-identical inputs: per-target keys keep every requester's closure (round-2 headline)", async () => {
    // The round-2 headline regression: with the outbox key = kind +
    // input hash ONLY, two distinct recipe nodes issuing identical
    // inputs collided — the first node's closure ran (writing ITS OWN
    // pending/result/error cells) and the second's was dropped at
    // admit, so the second node's cells stayed pending forever. The
    // key now carries the result-cell identity (effectTargetKey), so
    // each node keeps its own effect while same-node re-admits still
    // dedupe.
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { one: any; two: any }>(",
            "  ({ url }) => ({",
            "    one: fetchJsonUnchecked({ url }),",
            "    two: fetchJsonUnchecked({ url }),",
            "  }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "two-node-arg",
        undefined,
      );
      const result = runtime.getCell<{ one: unknown; two: unknown }>(
        space,
        "two-node-result",
        compiled.resultSchema,
      );
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
    const clientResult = clientRuntime.getCell<{
      one: { result?: { from?: string } };
      two: { result?: { from?: string } };
    }>(
      space,
      "two-node-result",
      undefined,
    );
    await clientResult.sync();
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate before the url write",
    );
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "two-node-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ url: "https://stage-g.test/shared" });
    expect((await tx.commit()).error).toBeUndefined();

    // BOTH nodes' cells serve. The pre-fix tree wedges exactly one of
    // these waits (whichever node's closure was admitted second).
    const served = (key: "one" | "two") =>
      (clientResult.key(key).key("result").get() as
        | { from?: string }
        | undefined)
        ?.from === "https://stage-g.test/shared";
    await waitUntil(
      () => served("one"),
      "node one to observe the result",
      30_000,
    );
    await waitUntil(
      () => served("two"),
      "node two to observe the result",
      30_000,
    );

    // Egress bounded: the contract pinned here is per-requester
    // DELIVERY with bounded calls — >=1 (a future response-sharing
    // fan-out may serve both nodes from one egress without breaking
    // this test) and <=4 (one per node plus the documented
    // at-least-once re-miss allowance per node).
    const shared = calls.filter((url) => url.endsWith("/shared")).length;
    expect(shared).toBeGreaterThanOrEqual(1);
    expect(shared).toBeLessThanOrEqual(4);
  });

  it("retires every served effect: the in-flight count returns to baseline after each completion settles — no monotonic leak (completion-visibility F1a)", async () => {
    // Pre-F1a, EVERY served effect leaked one permanently-in-flight
    // outbox entry and one unresolved whenApplied waiter (the parked
    // accept's marker never arrives for engine-plane commits). The pin:
    // across N sequential served effects, memo.inflight returns to 0
    // after each settles — not monotone growth.
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { fetch: any }>(",
            "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "liveness-arg",
        undefined,
      );
      const result = runtime.getCell<{ fetch: unknown }>(
        space,
        "liveness-result",
        compiled.resultSchema,
      );
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
    const clientResult = clientRuntime.getCell<
      { fetch: { result?: unknown; error?: unknown } }
    >(
      space,
      "liveness-result",
      undefined,
    );
    await clientResult.sync();
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate before the url writes",
    );
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "liveness-arg",
      undefined,
    );
    await clientArg.sync();

    for (const leg of ["n1", "n2", "n3"]) {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ url: `https://stage-g.test/${leg}` });
      expect((await tx.commit()).error).toBeUndefined();
      await waitUntil(
        () =>
          (clientResult.key("fetch").key("result").get() as {
            from?: string;
          } | undefined)?.from === `https://stage-g.test/${leg}`,
        `client to observe leg ${leg}`,
        30_000,
      );
      // The retirement-liveness pin: the completion settled (the value
      // is client-visible), so the whenApplied barrier resolved and the
      // entry retired. Pre-fix this stays at 1, 2, 3 — the leak.
      await waitUntil(
        () => host!.stats().memo.inflight === 0,
        `in-flight to return to baseline after leg ${leg}`,
        15_000,
      );
    }
    expect(host.stats().outbox.completed).toBeGreaterThanOrEqual(3);
  });

  it("commits an effect completion as its OWN derived-class commit, annotations sourced from the outbox carriage captured at the original run's seal (serving-loop.md §4; T7.Q4)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();
    openClient();

    // Activation via the client's demand.
    const watched = clientRuntime.getCell<{ value?: number }>(
      space,
      "completion-target",
      undefined,
    );
    await watched.sync();
    const kick = clientRuntime.getCell<{ n: number }>(
      space,
      "completion-kick",
      undefined,
    );
    const kickTx = clientRuntime.edit();
    kick.withTx(kickTx).set({ n: 1 });
    expect((await kickTx.commit()).error).toBeUndefined();
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate",
    );
    const engine = await server.engineForSpace(space);
    const spaceServer = host.spaceServer(space)!;

    // The ORIGINAL run: a stamped tx with an ACTING identity (the
    // carriage's attribution source — in Phase 2+ the stamper supplies
    // it; here the test does) enqueues the effect and seals into the
    // loop's wave. Its post-commit effect defers to the outbox and runs
    // AFTER the wave commit; the writeback — marked with the effect
    // key — commits as the §4 completion.
    const effectKey = "fetchTest:completion-e2e";
    const completed = Promise.withResolvers<void>();
    const serving = servingRuntime!;
    const target = serving.getCell<{ value?: number }>(
      space,
      "completion-target",
      undefined,
    );
    const scopedBase = serving.getCell<{ note?: string }>(
      space,
      "completion-scoped",
      undefined,
    );
    const scoped = serving.getCellFromLink<{ note?: string }>({
      ...scopedBase.getAsNormalizedFullLink(),
      scope: "user",
    });
    await target.sync();
    const originalTx = serving.edit();
    stampWaveRunContext(originalTx, {
      actionId: "test/fetch-node",
      kind: "derivation",
      acting: { user: "user:alice", session: "sess-9" },
    });
    target.withTx(originalTx).set({});
    originalTx.enqueuePostCommitEffect({
      id: effectKey,
      kind: "fetchTest-start",
      flush: () => {
        const work = serving.editWithRetry((tx) => {
          markEffectCompletion(tx, effectKey);
          target.withTx(tx).set({ value: 7 });
          scoped.withTx(tx).set({ note: "scoped completion" });
        }).then(({ error }) => {
          if (error !== undefined) {
            throw new Error(`completion write failed: ${error.message}`);
          }
          completed.resolve();
        });
        serving.trackAsyncWork(work);
      },
    });
    expect((await originalTx.commit()).error).toBeUndefined();
    await completed.promise;

    // The completion commit: derived-class under the holder, carrying
    // derivedThrough (protocol.md §4: every derived commit carries
    // it), EMPTY consequenceOf, and the annotation pair sourced from
    // the outbox carriage — the acting identity of the ORIGINAL run
    // and the scope_key resolved against the carriage identity. It is
    // its OWN commit: the wave that carried the original run's write
    // committed separately.
    const rows = engine.database.prepare(
      `SELECT seq, class, holder, derived_through, annotations,
              consequence_of
       FROM "commit" WHERE class = 'derived' ORDER BY seq`,
    ).all() as Array<{
      seq: number;
      class: string;
      holder: string;
      derived_through: number | null;
      annotations: string | null;
      consequence_of: string | null;
    }>;
    // BOTH the wave commit (the original stamped run's write, acting
    // attribution) and the completion carry annotations; the completion
    // is the one holding the SCOPED op's addressing half.
    const annotated = rows.filter((row) => row.annotations !== null).map(
      (row) => ({
        row,
        decoded: decodeMemoryBoundary(row.annotations!) as Array<
          Record<string, unknown>
        >,
      }),
    );
    const withScoped = annotated.filter(({ decoded }) =>
      decoded.some((annotation) => annotation.scopeKey !== undefined)
    );
    expect(withScoped.length).toBe(1);
    const completion = withScoped[0].row;
    expect(completion.holder).toBe(spaceServer.holder);
    expect(completion.derived_through).not.toBeNull();
    const annotations = withScoped[0].decoded;
    const expectedScopeKey = resolveScopeKey("user", {
      principal: serviceSigner.did(),
      sessionId: "unused",
    });
    // Every op carries the carriage's acting identity; the scoped op
    // additionally carries its scope_key (protocol.md §1's
    // addressing/attribution pair).
    expect(annotations.length).toBe(2);
    for (const annotation of annotations) {
      expect(annotation.actingUser).toBe("user:alice");
      expect(annotation.actingSession).toBe("sess-9");
    }
    expect(
      annotations.some((annotation) =>
        annotation.scopeKey === expectedScopeKey
      ),
    ).toBe(true);
    // The wave's own commit (the original run's write) is separate —
    // the completion never passed §3d's sealing.
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // In-process dirtiness + push: the client observes the completion
    // value through its ordinary subscription.
    await waitUntil(
      () => watched.key("value").get() === 7,
      "client to observe the completion write",
      15_000,
    );
    expect(host.stats().outbox.completed).toBeGreaterThanOrEqual(1);
  });
});
