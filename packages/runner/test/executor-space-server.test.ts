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
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
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
  targetStream: "of:stream-events:space-server",
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

  const newSpaceServer = (
    options: {
      serverFacade?: MemoryV2Server.Server;
      stats?: ServingLoopStats;
    } = {},
  ): SpaceServer => {
    const stats = options.stats ?? emptyServingLoopStats();
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
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
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
    const doc = Engine.read(targetEngine, {
      id: "of:stream-events:space-server",
    });
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
    const doc = Engine.read(targetEngine, {
      id: "of:stream-events:space-server",
    });
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
});
