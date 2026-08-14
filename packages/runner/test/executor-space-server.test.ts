// Server-execution v2 stage G: the SpaceServer's production recovery
// seams, pinned at the SpaceServer level (the stage-G review's M-B and
// m-3). The serving-loop E2E drives the happy path through the
// ExecutorHost; these tests pin the seams a deterministic suite left
// uncovered:
//
// - the §6-step-5 ACTIVATION RE-SEND: durable append rows written by a
//   wave that crashed/parked before delivery are delivered by the next
//   activation (delete the re-send call and the first test goes red);
// - the post-wave OWED drain: rows a transport-failed delivery leaves
//   behind ride the NEXT wave's drain even when that wave carries no
//   fresh appends (#outboxDrainOwed — armed by the failed activation
//   re-send too);
// - the park-race straggler drop (m-3): effects handed over for a wave
//   this server closed or abandoned are OWNED AND DROPPED — no
//   re-created #pendingEffectsByWave entry (the leak pin), no inline
//   flush firing network work for a contribution that never committed.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import { liveExecutionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import { decodeMemoryBoundary, resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import { SpaceServer } from "../src/executor/space-server.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../src/executor/stats.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("space-server test space");
const space = spaceSigner.did() as MemorySpace;
const targetSigner = await Identity.fromPassphrase("space-server test target");
const targetSpace = targetSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server test service",
);

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

const pendingRow = (eventId: string) => ({
  targetSpace,
  targetStream: "of:space-server-stream",
  eventId,
  payload: { via: "recovery seam" },
  actingPrincipal: "user:alice",
  actingSession: "sess-1",
  capabilityRef: "cap-r",
});

describe("stage G SpaceServer recovery seams", () => {
  let server: MemoryV2Server.Server;
  let engine: Engine.Engine;
  let servingRuntime: Runtime | undefined;
  let spaceServer: SpaceServer | undefined;

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    engine = await server.engineForSpace(space);
    servingRuntime = undefined;
    spaceServer = undefined;
  });

  afterEach(async () => {
    await spaceServer?.park("test-teardown");
    await server.close();
  });

  let lastStats = emptyServingLoopStats();

  const newSpaceServer = (
    options: {
      serverFacade?: MemoryV2Server.Server;
      stats?: ServingLoopStats;
      policy?: ConstructorParameters<typeof SpaceServer>[0]["policy"];
    } = {},
  ): SpaceServer => {
    const stats = options.stats ?? emptyServingLoopStats();
    lastStats = stats;
    const created = new SpaceServer({
      space,
      server: options.serverFacade ?? server,
      engine,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      localSeqRef: { value: 0 },
      stats,
      policy: options.policy ?? { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
    spaceServer = created;
    return created;
  };

  /** Seal one stamped probe write through the serving loop and wait for
   * its wave to commit — the deterministic "drive one wave" helper. */
  const driveOneWave = async (probeName: string): Promise<void> => {
    const runtime = servingRuntime!;
    const probe = runtime.getCell<{ n: number }>(space, probeName, undefined);
    await probe.sync();
    const seqBefore = Engine.serverSeq(engine);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: `test/${probeName}`,
      kind: "derivation",
    });
    probe.withTx(tx).set({ n: 1 });
    // Resolves at SEAL; the loop's cycle commits the wave.
    expect((await tx.commit()).error).toBeUndefined();
    await waitUntil(
      () => Engine.serverSeq(engine) > seqBefore,
      `the ${probeName} wave to commit`,
    );
  };

  it("refuses to activate on a runtime without servingPosture: the Phase-2 speculation default would divert factory-time loads (serving-loop.md §3)", async () => {
    const stats = emptyServingLoopStats();
    const rejecting = new SpaceServer({
      space,
      server,
      engine,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        // Deliberately NOT servingPosture: under the flag this runtime's
        // default seal destination is the client speculation overlay,
        // and its factory-time structure loads would divert instead of
        // committing through the loopback plane — the loud refusal is
        // the guard.
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      localSeqRef: { value: 0 },
      stats,
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
    await expect(rejecting.activate()).rejects.toThrow(
      /servingPosture/,
    );
    // The refused activation released the lease (no stranded row).
    expect(
      liveExecutionLeaseHolder(engine, space),
    ).toBeUndefined();
  });

  it("re-sends pending durable append rows on ACTIVATION (serving-loop.md §6 step 5): park-stranded rows deliver, then retire", async () => {
    // The crash/park window: a wave committed its append rows, the
    // process died before delivery. The rows are durable engine state —
    // model them directly.
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [pendingRow("evt-activation-resend")],
    });
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);

    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    // Delivered by the activation re-send itself — no wave ran (no
    // input, no demand): delete the re-send call in activate() and this
    // times out with the row still pending.
    await waitUntil(
      () =>
        selectPendingExecutionOutboxRows(engine, { branch: "" }).length === 0,
      "the activation re-send to retire the row",
    );
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, { id: "of:space-server-stream" });
    const entries = (doc?.value as { entries?: Array<Record<string, unknown>> })
      ?.entries ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0].eventId).toBe("evt-activation-resend");
  });

  it("keeps rows across a transport-failed activation re-send and delivers them on the NEXT wave's drain, without fresh appends (#outboxDrainOwed)", async () => {
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [pendingRow("evt-owed-drain")],
    });

    // A server whose delegated-append transport fails exactly once:
    // the activation re-send fails (rows survive), the next drain
    // succeeds.
    let failuresLeft = 1;
    const flakyOnce = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "commitDelegatedAppend" && failuresLeft > 0) {
          return () => {
            failuresLeft -= 1;
            return Promise.reject(new Error("transport down"));
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const created = newSpaceServer({
      serverFacade: flakyOnce as typeof server,
    });
    expect(await created.activate()).toBe(true);
    // The transport failure kept the row (admit-before-delete).
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);

    // Drive one wave that stages NO appends: the owed drain — armed by
    // the failed activation re-send — must deliver the surviving row.
    await driveOneWave("owed-drain-probe");
    await waitUntil(
      () =>
        selectPendingExecutionOutboxRows(engine, { branch: "" }).length === 0,
      "the owed post-wave drain to deliver the row",
    );
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, { id: "of:space-server-stream" });
    const entries = (doc?.value as { entries?: Array<unknown> })?.entries ?? [];
    expect(entries.length).toBe(1);
  });

  it("drops a straggler's effects for a closed or abandoned wave — owned, no re-created entry, no inline flush (m-3)", async () => {
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    // A stamped tx seals into a wave; the loop commits it (the wave
    // closes).
    const runtime = servingRuntime!;
    const probe = runtime.getCell<{ n: number }>(
      space,
      "m3-straggler-probe",
      undefined,
    );
    await probe.sync();
    const seqBefore = Engine.serverSeq(engine);
    const probeTx = runtime.edit();
    stampWaveRunContext(probeTx, {
      actionId: "test/m3-straggler",
      kind: "derivation",
    });
    probe.withTx(probeTx).set({ n: 1 });
    expect((await probeTx.commit()).error).toBeUndefined();
    await waitUntil(
      () => Engine.serverSeq(engine) > seqBefore,
      "the straggler's wave to commit",
    );

    // The straggler: a late deferSealedEffects for the CLOSED wave's tx
    // (in production, a continuation racing park/rotation). It must be
    // OWNED (true — the caller must not inline-flush network work for a
    // contribution whose wave is gone) and DROPPED (no map entry — the
    // pre-fix re-created one nothing would ever consume).
    let flushed = 0;
    const effect: PostCommitSideEffect = {
      id: "fetchTest:m3-straggler",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    };
    expect(created.deferSealedEffects(probeTx, [effect])).toBe(true);
    expect(created.deferredEffectWaveCount).toBe(0);
    expect(flushed).toBe(0);

    // Same drop once the space is PARKED (the !active arm): still
    // owned, still nothing stored or flushed.
    await created.park("m3-straggler-park");
    expect(created.deferSealedEffects(probeTx, [effect])).toBe(true);
    expect(created.deferredEffectWaveCount).toBe(0);
    expect(flushed).toBe(0);
  });

  it("clamps the W advance to the shadow floor — the min/max composition and serving-loop.md §7's counter, full suppression and the remove sentinel included — and the shadow-flip wake lifts the clamp promptly (Phase 2 settle input barrier)", async () => {
    const stats = emptyServingLoopStats();
    const created = newSpaceServer({ stats });
    expect(await created.activate()).toBe(true);

    // The serving replica, with the floor STUBBED: the replica-level
    // shadow machinery (recording, exemptions, the verdict-race
    // repair) is pinned in memory-v2-stacked-commit.test.ts; this test
    // pins the SpaceServer's half of the contract — what the loop DOES
    // with a floor.
    const replica = servingRuntime!.storageManager.open(space)
      .replica as unknown as {
        unappliedForeignSeqFloor?: () => number | undefined;
        shadowFlipObserver?: () => void;
      };
    // Activation installed the wake hook (the flip's dirtiness has no
    // admitted-commit record behind it, so nothing else ends the
    // loop's input wait before the idle timeout).
    expect(replica.shadowFlipObserver).toBeDefined();

    // Real commits via the memory server's direct-write path; the
    // notices are the host feed, supplied by hand in this direct-drive
    // harness (the ExecutorHost's admission observer in production).
    const write = async (doc: string): Promise<number> => {
      const applied = await server.writeDocument(space, doc, { n: 1 });
      return applied.seq;
    };
    const notice = (seq: number) =>
      created.enqueueCommit({
        space,
        seq,
        class: "system",
        sessionId: "session:clamp-probe",
        writes: [{ id: "of:clamp-probe", scopeKey: "space" }],
      });

    // Baseline: no floor, the advance reaches the batch head.
    const s1 = await write("of:clamp-a");
    notice(s1);
    await waitUntil(
      () => created.watermark === s1,
      "the un-clamped baseline advance",
    );
    expect(stats.watermarkClamped).toBe(0);

    // PARTIAL clamp: two inputs, the floor shadows the second — W
    // advances to floor-1, never the batch head. This pins the
    // composition: `inputVisibleHead = min(batchHead, floor-1)`,
    // `advanceTo = max(W, inputVisibleHead)` — invert either and the
    // assertions below go red (min→max advances past the floor;
    // max→min refuses the advance).
    let floor: number | undefined;
    replica.unappliedForeignSeqFloor = () => floor;
    const s2 = await write("of:clamp-b");
    const s3 = await write("of:clamp-c");
    floor = s3;
    // Enqueued back-to-back synchronously: one input batch, one cycle.
    notice(s2);
    notice(s3);
    await waitUntil(
      () => created.watermark === s2,
      "the clamped advance to floor-1",
    );
    expect(created.watermark).toBe(s3 - 1);
    expect(stats.watermarkClamped).toBe(1);

    // FULL suppression: the shadowed seq is the LOWEST input above W
    // (floor == W+1), so the advance is suppressed entirely
    // (advanceTo == W). §7's binding sentence — "waves whose W advance
    // was actually clamped below the input batch head" — counts
    // exactly this; the pre-fix guard required advanceTo > W and
    // missed it.
    const s4 = await write("of:clamp-d");
    notice(s4);
    await waitUntil(
      () => stats.watermarkClamped >= 2,
      "the fully-suppressed clamp to be counted",
    );
    expect(created.watermark).toBe(s2);
    expect(stats.watermarkClamped).toBe(2);

    // The REMOVE-sentinel floor (1): a shadowed remove carries no wire
    // seq, so its floor holds W entirely — counted the same way.
    floor = 1;
    const s5 = await write("of:clamp-e");
    notice(s5);
    await waitUntil(
      () => stats.watermarkClamped >= 3,
      "the sentinel-floored clamp to be counted",
    );
    expect(created.watermark).toBe(s2);

    // The PROMPT lift: the flip resolves the input wait directly — no
    // admitted commit remains on the feed (s3..s5 drained cycles ago;
    // only their VISIBILITY changed), so without the wake the catch-up
    // wave would sit out idleParkMs (600 s here) and this bounded wait
    // would time out. Fired the way the replica's confirmPending does
    // at promotion; poll-fired because the loop re-arms its wait
    // between cycles (a real promotion burst fires once per flipped
    // doc, so repeated fires are the production shape too).
    floor = undefined;
    await waitUntil(
      () => {
        replica.shadowFlipObserver?.();
        return created.watermark === s5;
      },
      "the clamp to lift promptly on the shadow-flip wake",
      15_000,
    );
    expect(stats.watermarkClamped).toBe(3);
  });

  it("fires an EFFECT-ONLY batch on a quiet space: an all-no-op tx's deferred effects close a vacuous wave instead of starving until park (round-2 thread 1)", async () => {
    // The §6-step-3 recovery shape: an activation re-run of an
    // effectful node whose claim is already durable seals an ALL-NO-OP
    // transaction (its claim writes elide) that carries only the
    // effect. It mints NO contribution, so the pre-fix loop — which
    // closed waves only for contributions or watermark movement —
    // never closed the wave holding the batch: on a quiet space the
    // effect starved, and the eventual idle park dropped it.
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    const runtime = servingRuntime!;
    let flushed = 0;
    const seqBefore = Engine.serverSeq(engine);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "test/effect-only-reissue",
      kind: "derivation",
    });
    // NO writes: the tx seals empty (contributes nothing) and carries
    // one deferred effect.
    tx.enqueuePostCommitEffect({
      id: "fetchTest:effect-only",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    });
    expect((await tx.commit()).error).toBeUndefined();

    // The effect must FIRE with no further input: the loop counts the
    // deferred batch as work, closes the (vacuous, zero-contribution)
    // wave, and admits the batch to the outbox.
    await waitUntil(
      () => flushed === 1,
      "the effect-only batch to fire on the quiet space",
    );
    // Vacuous close: nothing was committed for it.
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
    expect(created.deferredEffectWaveCount).toBe(0);
  });

  it("discards a REJECTED wave's effects: a terminal engine-side rejection withdraws the claims, so the batch must not egress (round-2 thread 3)", async () => {
    const created = newSpaceServer({
      // Renewals must not repair the lease mid-test: the rejection is
      // staged by deleting the engine-side lease row while the
      // in-process tenure stays valid.
      policy: {
        flushDeadlineMs: 2_000,
        idleParkMs: 600_000,
        renewIntervalMs: 600_000,
      },
    });
    expect(await created.activate()).toBe(true);
    const runtime = servingRuntime!;

    // Pull the engine-side lease row out from under the ACTIVE server:
    // the in-process tenure check still passes (no renew ran), so the
    // wave proceeds to its commit — where the engine's derived-class
    // admission (holder must hold the LIVE execution_lease) refuses it
    // with a conflict-less rejection: the accumulator's terminal
    // `aborted: "rejected"` arm, exactly the failed-wave shape the
    // admission gate must discard effects for.
    engine.database.prepare(
      `DELETE FROM execution_lease WHERE space = :space`,
    ).run({ space });

    let flushed = 0;
    const probe = runtime.getCell<{ n: number }>(
      space,
      "rejected-wave-probe",
      undefined,
    );
    await probe.sync();
    const seqBefore = Engine.serverSeq(engine);
    const wavesBefore = lastStats.waves;
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "test/rejected-wave",
      kind: "derivation",
    });
    probe.withTx(tx).set({ n: 1 });
    tx.enqueuePostCommitEffect({
      id: "fetchTest:rejected-wave",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    });
    expect((await tx.commit()).error).toBeUndefined();

    // The wave closes (counted) but commits nothing and — the pin —
    // its effects are DISCARDED, not admitted: the sealed claim writes
    // were withdrawn with the rejection, so firing would egress work
    // whose claim never became durable (pre-fix, every non-lease-lost
    // abort admitted the batch).
    await waitUntil(
      () => lastStats.waves > wavesBefore,
      "the rejected wave to be counted",
    );
    // Give a wrongly-admitted flush every chance to run before the
    // negative assertion.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushed).toBe(0);
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
  });

  // ---- stage P2-F: late-notice accounting (the sx2 unskip flake) ----

  it("counts an authored notice that arrives AFTER a higher-seq echo (the two-producer notice race): late records still count and re-arm, and coverage stays in-order", async () => {
    const stats = emptyServingLoopStats();
    const created = newSpaceServer({ stats });
    expect(await created.activate()).toBe(true);

    // Two REAL commits, enqueued out of order — the loop's own
    // post-commit notice (seq S+1) landing before the transact
    // path's async admission notice (seq S), exactly the in-process
    // race the unskipped sx2 gate exposed (authoredSeen undercounted
    // while W stayed honest).
    const first = await server.writeDocument(space, "of:p2f-late-a", {
      n: 1,
    });
    const second = await server.writeDocument(space, "of:p2f-late-b", {
      n: 2,
    });
    const authoredBefore = stats.authoredSeen;
    created.enqueueCommit({
      space,
      seq: second.seq,
      class: "authored",
      sessionId: "session:p2f-late",
      writes: [{ id: "of:p2f-late-b", scopeKey: "space" }],
    });
    await waitUntil(
      () => created.watermark >= second.seq,
      "the in-order record to drain and settle",
    );
    // The LATE notice: seq below the drained head. Pre-fix it was
    // silently skipped (never counted); post-fix it counts exactly
    // once — a replayed duplicate stays skipped.
    created.enqueueCommit({
      space,
      seq: first.seq,
      class: "authored",
      sessionId: "session:p2f-late",
      writes: [{ id: "of:p2f-late-a", scopeKey: "space" }],
    });
    await waitUntil(
      () => stats.authoredSeen === authoredBefore + 2,
      "the late authored notice to be counted",
    );
    created.enqueueCommit({
      space,
      seq: first.seq,
      class: "authored",
      sessionId: "session:p2f-late",
      writes: [{ id: "of:p2f-late-a", scopeKey: "space" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stats.authoredSeen).toBe(authoredBefore + 2);
    // Coverage math stayed in-order: W never regressed.
    expect(created.watermark).toBeGreaterThanOrEqual(second.seq);
  });

  // ---- stage P2-F: the demand-cycle terminal state (OW19) ----

  /** A facade whose watch registry names exactly the given demanded
   * roots — the unit-level stand-in for client sessions' watches (the
   * production feed is pinned in the serving-loop E2E). */
  const demandFacade = (
    roots: Array<{
      id: string;
      scope?: string;
      identity?: { principal?: string; sessionId?: string };
    }>,
  ): typeof server =>
    new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "watchedRootsForSpace") {
          return () => roots;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof server;

  it("terminalizes a confirmed no-meta demanded root and STOPS the per-cycle churn (OW19's terminal half)", async () => {
    // A doc that EXISTS durably with a plain value and NO pattern meta
    // — the never-a-piece `of:` class (registry/home/argument docs)
    // that id classes cannot exclude.
    await server.writeDocument(space, "of:p2f-terminal-root", { plain: 1 });

    const stats = emptyServingLoopStats();
    const created = newSpaceServer({
      stats,
      serverFacade: demandFacade([{ id: "of:p2f-terminal-root" }]),
    });
    expect(await created.activate()).toBe(true);

    // The root terminalizes: attempted, confirmed synced-no-meta,
    // parked — counted once.
    await waitUntil(
      () => stats.structureLoadTerminal === 1,
      "the demanded root to terminalize",
    );

    // THE CHURN STOPS (the starvation fork's fix): further cycles —
    // driven by unrelated commits — re-attempt NOTHING for the parked
    // root. Pre-P2-F every input-driven cycle re-ran the ensure
    // (structureLoadDeferred grew per cycle, unbounded).
    const deferredAtTerminal = stats.structureLoadDeferred;
    const terminalAtTerminal = stats.structureLoadTerminal;
    for (let i = 0; i < 4; i++) {
      const applied = await server.writeDocument(
        space,
        `of:p2f-unrelated-${i}`,
        { n: i },
      );
      created.enqueueCommit({
        space,
        seq: applied.seq,
        class: "system",
        sessionId: "session:p2f-unrelated",
        writes: [{ id: `of:p2f-unrelated-${i}`, scopeKey: "space" }],
      });
      await waitUntil(
        () => created.watermark >= applied.seq,
        `unrelated cycle ${i} to settle`,
      );
    }
    expect(stats.structureLoadDeferred).toBe(deferredAtTerminal);
    expect(stats.structureLoadTerminal).toBe(terminalAtTerminal);
    expect(stats.structureLoadRearmed).toBe(0);
    expect(stats.structureLoadFailures).toBe(0);
  });

  it("re-arms a terminal root on a commit touching it and LOADS a piece created after the terminal decision (OW19's not-yet half)", async () => {
    const stats = emptyServingLoopStats();
    const rootName = "p2f-created-later";
    const created = newSpaceServer({ stats });
    expect(await created.activate()).toBe(true);
    const runtime = servingRuntime!;

    // The demanded root's id BEFORE anything exists at it — the
    // creation race's first half: demand precedes the piece.
    const rootCell = runtime.getCell<{ total?: number }>(
      space,
      rootName,
      undefined,
    );
    const rootId = rootCell.getAsNormalizedFullLink().id;

    // Point the demand facade at it (swapped in via the server's
    // observer seam: the SpaceServer reads watchedRootsForSpace on
    // every demand pass, so overriding the method on the shared server
    // object works mid-flight).
    const originalWatched = server.watchedRootsForSpace.bind(server);
    (server as { watchedRootsForSpace: unknown }).watchedRootsForSpace =
      () => [{ id: rootId }];
    try {
      // Fire a demand pass; the absent root confirms no-meta and
      // terminalizes (not-yet and never are indistinguishable HERE —
      // the re-arm below is what distinguishes them). Poll-fired: the
      // wake resolves the loop's input wait, which is re-armed between
      // cycles (the clamp test's idiom).
      await waitUntil(
        () => {
          created.noteDemandChanged();
          return stats.structureLoadTerminal === 1;
        },
        "the not-yet-created root to terminalize",
      );

      // NOW create the piece at that root through a CLIENT runtime —
      // the scheduler tell's creation shape (an outside-scheduler
      // authored act; protocol.md §1): its commit is a fresh authored
      // admission whose notice the admission hook would deliver — this
      // direct-drive harness hand-feeds the same notice with the
      // commit's REAL seq.
      const creatorManager = EmulatedStorageManager.connectTo(server, {
        as: spaceSigner,
      });
      const creator = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: creatorManager,
      });
      try {
        const compiled = await creator.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { computed, pattern } from 'commonfabric';",
              "export default pattern<{ n: number }, { total: number }>(",
              "  ({ n }) => ({ total: computed(() => n + 7) }),",
              ");",
            ].join("\n"),
          }],
        }, { space });
        const argument = creator.getCell<{ n: number }>(
          space,
          "p2f-created-later-arg",
          undefined,
        );
        const creatorRoot = creator.getCell<{ total?: number }>(
          space,
          rootName,
          undefined,
        );
        await argument.sync();
        await creatorRoot.sync();
        const argTx = creator.edit();
        argument.withTx(argTx).set({ n: 1 });
        creator.run(argTx, compiled, argument, creatorRoot);
        expect((await argTx.commit()).error).toBeUndefined();
        await creator.idle();
        await creator.storageManager.synced();
      } finally {
        await creator.dispose();
        await creatorManager.close();
      }
      const creationSeq = Engine.serverSeq(engine);
      created.enqueueCommit({
        space,
        seq: creationSeq,
        class: "authored",
        sessionId: "session:p2f-creator",
        writes: [{ id: rootId, scopeKey: "space" }],
      });

      await waitUntil(
        () => stats.structureLoadRearmed === 1,
        "the terminal root to re-arm on the creation commit",
      );
      // The settle-gated retry LOADS the piece: no re-terminalization,
      // and the piece's derivation serves — the derived total lands in
      // the engine under a derived-class commit.
      await waitUntil(
        () => {
          const row = engine.database.prepare(
            `SELECT c.class AS class FROM revision r
             JOIN "commit" c ON c.seq = r.commit_seq
             WHERE r.id LIKE 'computed:%' ORDER BY r.seq DESC LIMIT 1`,
          ).get() as { class: string } | undefined;
          return row?.class === "derived";
        },
        "the re-armed piece to derive server-side",
        15_000,
      );
      expect(stats.structureLoadTerminal).toBe(1);
      expect(stats.structureLoadFailures).toBe(0);
    } finally {
      (server as { watchedRootsForSpace: unknown }).watchedRootsForSpace =
        originalWatched;
    }
  });

  // ---- stage P2-F: the argument-doc demand → owning-piece run supply ----

  it("supplies a scoped ARGUMENT-doc demand's identity to the owning piece's derivation runs: the ensure-resolved root differs from the demanded id, and the derived commit still carries the demanding actor (the #pieceRootByDemandKey arm)", async () => {
    // An ordinary nested-doc watch: the client's scoped subscription
    // names the piece's ARGUMENT doc, not its result root. The demand
    // key therefore never matches the piece root by suffix — the run
    // supply finds the demand's identity ONLY through the structure
    // load's resolved-root mapping. If that mapping silently breaks,
    // the demanded derivation falls back to the wave identity and its
    // writes classify USERLESS — the exact misclassification stage
    // P2-F exists to end, which is why this pin binds the OBSERVABLE
    // (the derived commit's acting annotations), not the map.
    //
    // The piece, created BEFORE serving starts, via a client runtime.
    // The demanded doc is the piece's argument META doc (the runner's
    // own argument cell, which carries the `result` backlink the
    // ensure traversal follows to the owning root).
    const creatorManager = EmulatedStorageManager.connectTo(server, {
      as: spaceSigner,
    });
    const creator = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: creatorManager,
    });
    let pieceRootId: string;
    let argMetaDocId: string;
    let inputDocId: string;
    try {
      const compiled = await creator.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 7) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const input = creator.getCell<{ n: number }>(
        space,
        "p2f-argdemand-input",
        undefined,
      );
      const root = creator.getCell<{ total?: number }>(
        space,
        "p2f-argdemand-root",
        undefined,
      );
      await input.sync();
      await root.sync();
      const tx = creator.edit();
      input.withTx(tx).set({ n: 1 });
      creator.run(tx, compiled, input, root);
      expect((await tx.commit()).error).toBeUndefined();
      await creator.idle();
      await creator.storageManager.synced();
      pieceRootId = root.getAsNormalizedFullLink().id;
      inputDocId = input.getAsNormalizedFullLink().id;
      argMetaDocId = getMetaLink(root, "argument")!.id;
    } finally {
      await creator.dispose();
      await creatorManager.close();
    }
    // The mapping premise: the demanded id is NOT the owning root.
    expect(argMetaDocId).not.toBe(pieceRootId);

    // The demander's scoped watch on the argument doc (identity-
    // bearing) coexists with a plain space demand on the piece root
    // (the value subscription that pulls the derivation; it carries no
    // identity and mints no run of its own — scopes.md §5: the run set
    // is exactly the identity-bearing demand entries, and a coexisting
    // space demand rides those runs).
    const demander = {
      principal: "did:key:p2f-argdemander",
      sessionId: "argdemander-s1",
    };
    const stats = emptyServingLoopStats();
    const created = newSpaceServer({
      stats,
      serverFacade: demandFacade([
        { id: pieceRootId },
        { id: argMetaDocId, scope: "user", identity: demander },
      ]),
    });
    expect(await created.activate()).toBe(true);

    // The authored input: a client writes the piece's argument value;
    // the notice drives the cycle whose wave re-derives `total` — as
    // the DEMANDING instance.
    const pokerManager = EmulatedStorageManager.connectTo(server, {
      as: spaceSigner,
    });
    const poker = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: pokerManager,
    });
    try {
      const input = poker.getCell<{ n: number }>(
        space,
        "p2f-argdemand-input",
        undefined,
      );
      await input.sync();
      const pokeTx = poker.edit();
      input.withTx(pokeTx).set({ n: 2 });
      expect((await pokeTx.commit()).error).toBeUndefined();
      await poker.storageManager.synced();
    } finally {
      await poker.dispose();
      await pokerManager.close();
    }
    created.enqueueCommit({
      space,
      seq: Engine.serverSeq(engine),
      class: "authored",
      sessionId: "session:p2f-argdemand-poker",
      writes: [{ id: inputDocId, scopeKey: "space" }],
    });

    // THE PIN (neutralization red: with the `#pieceRootByDemandKey`
    // match removed from `#runInstancesFor` — or the setter that feeds
    // it dropped — no instance resolves for the owning root, the run
    // falls back to the wave identity, and no acting annotation ever
    // lands): the derived commit's write annotations carry the
    // demanding (user, session).
    const actingRows = () => {
      const rows = engine.database.prepare(
        `SELECT annotations FROM "commit" WHERE class = 'derived' AND
         annotations IS NOT NULL`,
      ).all() as Array<{ annotations: string }>;
      return rows.flatMap((row) =>
        decodeMemoryBoundary(row.annotations) as unknown as Array<{
          actingUser?: string;
          actingSession?: string;
        }>
      ).filter((annotation) => annotation.actingUser !== undefined);
    };
    await waitUntil(
      () => actingRows().some((a) => a.actingUser === demander.principal),
      "the argument-demand derivation to act as the demanding user",
      15_000,
    );
    expect(
      actingRows().some((a) =>
        a.actingUser === demander.principal &&
        a.actingSession === demander.sessionId
      ),
    ).toBe(true);

    // The same run's basis rows key under the demander's INSTANCE
    // (serving-loop.md §3b's action_scope_key) — the supply reached
    // keys, not only stamps.
    const expectedInstanceKey = resolveScopeKey("user", demander as never);
    const basisKeys = new Set(
      (engine.database.prepare(
        `SELECT DISTINCT action_scope_key FROM scheduler_basis`,
      ).all() as Array<{ action_scope_key: string }>).map((row) =>
        row.action_scope_key
      ),
    );
    expect(basisKeys.has(expectedInstanceKey)).toBe(true);

    // The argument-doc demand RESOLVED (started through the owning
    // root) — it neither terminalized nor failed.
    expect(stats.structureLoadTerminal).toBe(0);
    expect(stats.structureLoadFailures).toBe(0);
  });
});
