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
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import { SpaceServer } from "../src/executor/space-server.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
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
      policy?: ConstructorParameters<typeof SpaceServer>[0]["policy"];
    } = {},
  ): SpaceServer => {
    const stats = emptyServingLoopStats();
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
});
