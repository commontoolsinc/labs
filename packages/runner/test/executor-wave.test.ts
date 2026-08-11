// Server-execution v2 stage D: seal-into-wave, end to end against a real
// Runtime, storage stack, and engine (serving-loop.md §3c–§3d). The
// executable spec model (packages/spec-model/server-execution) is the
// semantic oracle for this machinery; the tests here pin the same ruled
// semantics at the implementation layer:
//
// - one abstraction, two destinations: without a destination the commit
//   path is today's, byte for byte (nothing here runs off the flag; the
//   whole existing suite is the OFF-arm witness), and installing one off
//   the flag is refused;
// - unstamped seals are REFUSED at the destination (serving-loop.md §3d,
//   RULED 2026-08-05): every server-side commit path stamps its run
//   context before sealing — no anonymous fallback;
// - the layered view: a later action tx reads an earlier tx's sealed
//   writes through the ordinary read path, and nothing reaches the store
//   until the wave commits — then everything lands as ONE commit;
// - C8a: a superseded pure-derivation write DROPS at the per-doc CAS
//   (counted supersededWrites), the concurrent authored value survives,
//   and a dependent derivation that read the withdrawn write drops with
//   it (never committed blind);
// - C8b/C9: a raced non-re-derivable consequence REQUEUES — never lost
//   (the re-run in a later wave commits it, consequenceOf carries the
//   eventId exactly once across both waves), never doubled — while a
//   commuting consequence REBASES and commits;
// - sealing order: the wave commit preserves seal order, never reorders;
// - identity annotations attach at seal time and ride the wave commit
//   (protocol.md §1), and basis rows land per (action, instance) in the
//   same store transaction (serving-loop.md §3b);
// - DR1/§2: a lease lost mid-wave aborts the wave commit — work sealed
//   under a lapsed tenure never commits;
// - protocol.md §2b: multi-space seals commit foreign-first, and a
//   foreign failure withholds the home commit.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  EXECUTION_LEASE_TTL_MS,
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { selectSchedulerBasisRows } from "@commonfabric/memory/v2/scheduler-basis";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, Result } from "../src/storage/interface.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveCommitRejection,
  type WaveCommitSink,
} from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("executor wave test");
const space = signer.did() as MemorySpace;

describe("stage D seal-into-wave", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;

  const newWave = (options: {
    lease?: ConstructorParameters<typeof WaveAccumulator>[0]["lease"];
  } = {}): WaveAccumulator =>
    new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      // OFF-arm cardinality 1: the instance keys derive from the
      // runtime's own authenticated session (plan Phase 1 stage E). The
      // accumulator constructs keys via the ONE shared constructor — a
      // test cannot hand it a different format (key-vocabulary.md §4).
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-test-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      ...(options.lease !== undefined ? { lease: options.lease } : {}),
    });

  const newSink = (): EngineWaveCommitSink =>
    new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: "wave-test-service",
    });

  const liveLease = (): ExecutionLeaseCycle => {
    const cycle = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    if (!cycle.acquire()) throw new Error("test lease acquire failed");
    return cycle;
  };

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    engine = await server.engineForSpace(space);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("refuses a seal destination off the flag", async () => {
    const offManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const offRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: offManager,
      experimental: { serverExecution: false },
    });
    try {
      expect(() => offRuntime.installSealDestination(newWave())).toThrow(
        "EXPERIMENTAL_SERVER_EXECUTION",
      );
    } finally {
      await offRuntime.dispose();
      await offManager.close();
    }
  });

  it("refuses an unstamped seal: every server-side commit path stamps its run context (RULED 2026-08-05)", async () => {
    const wave = newWave();
    runtime.installSealDestination(wave);
    const doc = runtime.getCell<{ value: number }>(
      space,
      "wave-unstamped",
      undefined,
    );
    const seqBefore = Engine.serverSeq(engine);

    // No stampWaveRunContext call: the seal destination must refuse
    // loudly — never fall back to an anonymous derivation. (Red-first:
    // pre-ruling, this commit was ACCEPTED as an anonymous
    // contribution — error undefined, contributionCount 1.)
    const tx = runtime.edit();
    doc.withTx(tx).set({ value: 1 });
    await expect(tx.commit()).rejects.toThrow(
      "unstamped transaction sealed into a wave",
    );

    // Nothing entered the wave and nothing reached the store.
    expect(wave.contributionCount).toBe(0);
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
    runtime.clearSealDestination();
  });

  it("seals into the wave instead of committing; later txs read the layered view; the wave commits once", async () => {
    const lease = liveLease();
    const leasedWave = newWave({ lease });
    runtime.installSealDestination(leasedWave);

    const a = runtime.getCell<{ value: number }>(space, "wave-a", undefined);
    const b = runtime.getCell<{ value: number }>(space, "wave-b", undefined);
    const seqBefore = Engine.serverSeq(engine);

    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-a", kind: "derivation" });
    a.withTx(tx1).set({ value: 1 });
    expect((await tx1.commit()).error).toBeUndefined();

    // Nothing reached the store: the sealed write lives in the overlay.
    expect(Engine.serverSeq(engine)).toBe(seqBefore);

    // The layered view: a later action tx reads the sealed write through
    // the ordinary read path, and its own write joins the wave.
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-b", kind: "derivation" });
    const seen = a.withTx(tx2).get();
    expect(seen).toEqual({ value: 1 });
    b.withTx(tx2).set({ value: seen!.value + 1 });
    expect((await tx2.commit()).error).toBeUndefined();
    expect(leasedWave.contributionCount).toBe(2);

    runtime.clearSealDestination();
    const outcome = await leasedWave.commitWave(newSink());
    await leasedWave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(0);
    expect(outcome.dispositions).toEqual([
      { kind: "committed" },
      { kind: "committed" },
    ]);
    // ONE derived commit carries both actions' writes, in seal order.
    expect(Engine.serverSeq(engine)).toBe(outcome.seq);
    const aLink = a.getAsNormalizedFullLink();
    const bLink = b.getAsNormalizedFullLink();
    const revisions = engine.database.prepare(
      `SELECT id FROM revision WHERE seq = :seq ORDER BY op_index`,
    ).all({ seq: outcome.seq }) as { id: string }[];
    expect(revisions.map((r) => r.id)).toEqual([aLink.id, bLink.id]);
    const commitMeta = engine.database.prepare(
      `SELECT class, holder FROM "commit" WHERE seq = :seq`,
    ).get({ seq: outcome.seq }) as { class: string; holder: string };
    expect(commitMeta.class).toBe("derived");
    expect(commitMeta.holder).toBe(lease.holder);
  });

  it("drops superseded pure writes (C8a) and the derivations that read them; the authored value survives", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const x = runtime.getCell<{ value: number }>(space, "wave-x", undefined);
    const z = runtime.getCell<{ value: number }>(space, "wave-z", undefined);

    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 10 });
    expect((await tx1.commit()).error).toBeUndefined();

    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-z", kind: "derivation" });
    const seen = x.withTx(tx2).get();
    z.withTx(tx2).set({ value: seen!.value + 1 });
    expect((await tx2.commit()).error).toBeUndefined();

    // A concurrent authored commit lands mid-wave and moves x's head past
    // the wave's basis: the next wave's input, and this wave's conflict.
    const xLink = x.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: xLink.id,
          value: { value: { value: 99 } },
        }],
      },
    });

    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    // The superseded pure write dropped (counted), and the derivation
    // that READ the withdrawn write dropped with it — nothing derived
    // from withdrawn state commits.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    expect(outcome.dispositions[0]).toEqual({ kind: "dropped" });
    expect(outcome.dispositions[1]).toEqual({ kind: "dropped" });
    // No wave commit happened at all (nothing survived), and the
    // authored value stands — dropping is what makes that sound.
    expect(outcome.seq).toBeUndefined();
    const zLink = z.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: zLink.id, scopeKey: "space" }),
    ).toBe(0);
    const stored = Engine.readState(engine, { id: xLink.id });
    expect(stored?.document).toEqual({ value: { value: 99 } });
  });

  it("requeues a raced consequence (C8b) — never lost, never doubled across waves — and annotates + records its basis when it lands", async () => {
    const lease = liveLease();

    const y = runtime.getCell<{ value: number }>(space, "wave-y", undefined);
    const seed = runtime.getCell<{ value: number }>(
      space,
      "wave-seed",
      undefined,
    );

    // Seed a doc the handler reads, so basis rows have a confirmed read.
    const seedTx = runtime.edit();
    seed.withTx(seedTx).set({ value: 7 });
    expect((await seedTx.commit()).error).toBeUndefined();
    const seedSeq = Engine.serverSeq(engine);

    const wave1 = newWave({ lease });
    runtime.installSealDestination(wave1);

    const handlerRun = async (accumulator: WaveAccumulator) => {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "handle-vote",
        kind: "event-handler",
        eventId: "e1",
        acting: { user: "did:key:alice", session: "sess-1" },
      });
      const base = seed.withTx(tx).get();
      y.withTx(tx).set({ value: base!.value + 1 });
      expect((await tx.commit()).error).toBeUndefined();
      return accumulator;
    };
    await handlerRun(wave1);

    // A rival authored write races the consequence on the same doc: a
    // whole-doc set never commutes, so the rebase conflicts semantically.
    const yLink = y.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: yLink.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    runtime.clearSealDestination();
    const outcome1 = await wave1.commitWave(newSink());
    await wave1.settled();

    // REQUEUED, not lost, not committed, not consequenced: §3d's T3 row.
    expect(outcome1.requeuedEventIds).toEqual(["e1"]);
    expect(outcome1.committedEventIds).toEqual([]);
    expect(outcome1.dispositions[0]).toEqual({ kind: "requeued" });
    expect(outcome1.seq).toBeUndefined();

    // The later wave retries the event against fresh state: exactly once.
    const wave2 = newWave({ lease });
    runtime.installSealDestination(wave2);
    await handlerRun(wave2);
    runtime.clearSealDestination();
    const sink = newSink();
    const outcome2 = await wave2.commitWave(sink);
    await wave2.settled();

    expect(outcome2.aborted).toBeUndefined();
    expect(outcome2.committedEventIds).toEqual(["e1"]);
    expect(outcome2.requeuedEventIds).toEqual([]);

    // consequenceOf carries e1 exactly once across both waves, the
    // acting identity annotations rode the write (protocol.md §1), and
    // the handler's basis rows landed per (action, instance) in the same
    // store transaction (serving-loop.md §3b).
    const rows = engine.database.prepare(
      `SELECT seq, consequence_of, annotations FROM "commit"
       WHERE consequence_of IS NOT NULL`,
    ).all() as { seq: number; consequence_of: string; annotations: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].seq).toBe(outcome2.seq);
    expect(decodeMemoryBoundary(rows[0].consequence_of)).toEqual(["e1"]);
    const annotations = decodeMemoryBoundary(rows[0].annotations) as Array<
      Record<string, unknown>
    >;
    expect(annotations).toEqual([
      { op: 0, actingUser: "did:key:alice", actingSession: "sess-1" },
    ]);
    const basis = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "handle-vote",
      actionScopeKey: "space",
    });
    const seedLink = seed.getAsNormalizedFullLink();
    const seedRow = basis.find((row) => row.entity === seedLink.id);
    expect(seedRow).toEqual({
      entitySpace: space,
      entity: seedLink.id,
      entityScopeKey: "space",
      seq: seedSeq,
    });
  });

  it("rebases a commuting consequence instead of requeueing (field-level merge)", async () => {
    const lease = liveLease();

    // Seed a structured doc, then patch disjoint fields concurrently.
    const doc = runtime.getCell<{ a: number; b: number }>(
      space,
      "wave-rebase",
      undefined,
    );
    const seedTx = runtime.edit();
    doc.withTx(seedTx).set({ a: 1, b: 1 });
    expect((await seedTx.commit()).error).toBeUndefined();

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "handle-a",
      kind: "event-handler",
      eventId: "e-rebase",
      acting: { user: "did:key:alice" },
    });
    doc.withTx(tx).key("a").set(2);
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // The rival touches ONLY /value/b — disjoint from the handler's
    // /value/a patch, so the consequence commutes and rebases.
    const link = doc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: link.id,
          patches: [{ op: "replace", path: "/value/b", value: 50 }],
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.requeuedEventIds).toEqual([]);
    expect(outcome.committedEventIds).toEqual(["e-rebase"]);
    // Both writes survive: the rival's b and the rebased consequence's a.
    const stored = Engine.readState(engine, { id: link.id });
    expect(stored?.document).toEqual({ value: { a: 2, b: 50 } });
  });

  it("aborts the wave commit when the lease tenure lapsed (work sealed under a lapsed tenure never commits)", async () => {
    let now = 1_000_000;
    const cycle = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(`service:${space}`),
      now: () => now,
    });
    expect(cycle.acquire()).toBe(true);

    const wave = newWave({ lease: cycle });
    runtime.installSealDestination(wave);
    const cell = runtime.getCell<{ value: number }>(
      space,
      "wave-tenure",
      undefined,
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "handle-late",
      kind: "event-handler",
      eventId: "e-late",
    });
    cell.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // The lease expires (a pause outlived the TTL) and the same process
    // reacquires: a NEW tenure. The renewal failure is the
    // stop-committing signal; the in-flight wave aborts (§2's MUST).
    now += EXECUTION_LEASE_TTL_MS + 1;
    expect(cycle.renew()).toBe(false);
    expect(cycle.acquire()).toBe(true);

    const seqBefore = Engine.serverSeq(engine);
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBe("lease-lost");
    expect(outcome.requeuedEventIds).toEqual(["e-late"]);
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
  });

  it("commits multi-space seals foreign-first and withholds the home commit on a foreign failure (protocol.md §2b)", async () => {
    const foreignSigner = await Identity.fromPassphrase("wave foreign space");
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    const lease = liveLease();

    const engines = new Map<MemorySpace, Engine.Engine>([
      [space, engine],
      [foreign, foreignEngine],
    ]);

    const runProvisioningWave = async (value: number): Promise<
      {
        wave: WaveAccumulator;
        order: Array<{ space: MemorySpace; home: boolean }>;
      }
    > => {
      const wave = newWave({ lease });
      runtime.installSealDestination(wave);
      const homeCell = runtime.getCell<{ value: number }>(
        space,
        "wave-home-link",
        undefined,
      );
      const foreignCell = runtime.getCell<{ value: number }>(
        foreign,
        "wave-provisioned",
        undefined,
      );
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "provision",
        kind: "event-handler",
        eventId: "e-prov",
        acting: { user: "did:key:alice", session: "sess-1" },
      });
      tx.enableMultiSpaceWrites?.([foreign, space]);
      foreignCell.withTx(tx).set({ value });
      homeCell.withTx(tx).set({ value: value + 1 });
      expect((await tx.commit()).error).toBeUndefined();
      runtime.clearSealDestination();
      const order: Array<{ space: MemorySpace; home: boolean }> = [];
      return { wave, order };
    };

    // First: the foreign-first ordering on success.
    {
      const { wave, order } = await runProvisioningWave(1);
      const inner = new EngineWaveCommitSink({
        engineFor: (s) => engines.get(s)!,
        sessionId: "wave-test-service",
      });
      const recordingSink: WaveCommitSink = {
        currentHeads: (s, docs) => inner.currentHeads(s, docs),
        concurrentWritePaths: (s, doc, since) =>
          inner.concurrentWritePaths(s, doc, since),
        commitWave: (batch) => {
          order.push({ space: batch.space, home: batch.home });
          return inner.commitWave(batch);
        },
      };
      const outcome = await wave.commitWave(recordingSink);
      await wave.settled();
      expect(outcome.aborted).toBeUndefined();
      expect(order).toEqual([
        { space: foreign, home: false },
        { space, home: true },
      ]);
      // The foreign commit is authored-class; the home commit derived.
      const foreignClass = foreignEngine.database.prepare(
        `SELECT class FROM "commit" ORDER BY seq DESC LIMIT 1`,
      ).get() as { class: string };
      expect(foreignClass.class).toBe("authored");
    }

    // Then: a foreign failure withholds the home commit and requeues.
    {
      const { wave } = await runProvisioningWave(10);
      const inner = new EngineWaveCommitSink({
        engineFor: (s) => engines.get(s)!,
        sessionId: "wave-test-service-2",
      });
      const failingSink: WaveCommitSink = {
        currentHeads: (s, docs) => inner.currentHeads(s, docs),
        concurrentWritePaths: (s, doc, since) =>
          inner.concurrentWritePaths(s, doc, since),
        commitWave: (
          batch,
        ): Promise<Result<{ seq: number }, WaveCommitRejection>> => {
          if (!batch.home) {
            return Promise.resolve({
              error: {
                name: "WaveCommitRejected",
                message: "injected foreign failure",
              },
            });
          }
          return inner.commitWave(batch);
        },
      };
      const homeSeqBefore = Engine.serverSeq(engine);
      const outcome = await wave.commitWave(failingSink);
      await wave.settled();
      expect(outcome.aborted).toBe("foreign-commit-failed");
      expect(outcome.requeuedEventIds).toEqual(["e-prov"]);
      // The home commit never landed: the event stays unconsequenced and
      // replays (§2b).
      expect(Engine.serverSeq(engine)).toBe(homeSeqBefore);
    }
  });

  it("folds a reader of a FOREIGN sealed write into the writer's withdrawal (cross-space withdrawn-read closure)", async () => {
    const foreignSigner = await Identity.fromPassphrase("wave foreign closure");
    const foreign = foreignSigner.did() as MemorySpace;
    const foreignEngine = await server.engineForSpace(foreign);
    const lease = liveLease();
    const engines = new Map<MemorySpace, Engine.Engine>([
      [space, engine],
      [foreign, foreignEngine],
    ]);

    const homeDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-xspace-home",
      undefined,
    );
    const foreignSeed = runtime.getCell<{ value: number }>(
      foreign,
      "wave-xspace-foreign-seed",
      undefined,
    );
    const foreignOut = runtime.getCell<{ value: number }>(
      foreign,
      "wave-xspace-foreign-out",
      undefined,
    );
    const homeOut = runtime.getCell<{ value: number }>(
      space,
      "wave-xspace-home-out",
      undefined,
    );

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    // The writer: a provisioning handler seals a FOREIGN write plus a
    // home write a rival will race (whole-doc set → semantic conflict →
    // requeue in the first resolve pass).
    const writerTx = runtime.edit();
    stampWaveRunContext(writerTx, {
      actionId: "provision-writer",
      kind: "event-handler",
      eventId: "e-foreign-writer",
      acting: { user: "did:key:alice", session: "sess-1" },
    });
    writerTx.enableMultiSpaceWrites?.([foreign, space]);
    foreignSeed.withTx(writerTx).set({ value: 3 });
    homeDoc.withTx(writerTx).set({ value: 1 });
    expect((await writerTx.commit()).error).toBeUndefined();

    // The reader: reads the writer's FOREIGN sealed write through the
    // foreign replica's layered view and derives writes in both spaces.
    const readerTx = runtime.edit();
    stampWaveRunContext(readerTx, {
      actionId: "derive-from-foreign",
      kind: "derivation",
    });
    readerTx.enableMultiSpaceWrites?.([foreign, space]);
    const seen = foreignSeed.withTx(readerTx).get();
    expect(seen).toEqual({ value: 3 });
    foreignOut.withTx(readerTx).set({ value: seen!.value + 1 });
    homeOut.withTx(readerTx).set({ value: seen!.value + 10 });
    expect((await readerTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const homeLink = homeDoc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: homeLink.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    const sink = new EngineWaveCommitSink({
      engineFor: (s) => engines.get(s)!,
      sessionId: "wave-test-service",
    });
    const outcome = await wave.commitWave(sink);
    await wave.settled();

    // The writer requeued, so its foreign write never lands — and the
    // reader derived from it, so NOTHING the reader wrote may commit,
    // in EITHER space (§3d: no blind derived writes). The foreign read
    // rides the reader's foreign sealed commit, which is what the
    // per-space closure resolves it against.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.requeuedEventIds).toEqual(["e-foreign-writer"]);
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "dropped" },
    ]);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    const foreignOutLink = foreignOut.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(foreignEngine, {
        id: foreignOutLink.id,
        scopeKey: "space",
      }),
    ).toBe(0);
    const homeOutLink = homeOut.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: homeOutLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("disposes each contribution's writes to a conflicted doc independently: one handler's rebase never absolves a derivation's superseded write", async () => {
    const lease = liveLease();

    const doc = runtime.getCell<{ a: number; b: number }>(
      space,
      "wave-mixed",
      undefined,
    );
    const input = runtime.getCell<{ value: number }>(
      space,
      "wave-mixed-input",
      undefined,
    );
    const seedTx = runtime.edit();
    doc.withTx(seedTx).set({ a: 1, b: 1 });
    input.withTx(seedTx).set({ value: 5 });
    expect((await seedTx.commit()).error).toBeUndefined();
    const inputSeq = Engine.serverSeq(engine);

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    // A handler patches /value/a — disjoint from the rival, so it
    // legitimately rebases.
    const handlerTx = runtime.edit();
    stampWaveRunContext(handlerTx, {
      actionId: "handle-a",
      kind: "event-handler",
      eventId: "e-mixed",
      acting: { user: "did:key:alice" },
    });
    doc.withTx(handlerTx).key("a").set(2);
    expect((await handlerTx.commit()).error).toBeUndefined();

    // A pure derivation READS an input and whole-doc-sets the SAME doc:
    // its write must be judged on its own — superseded, dropped — not
    // ride the handler's rebase.
    const derivationTx = runtime.edit();
    stampWaveRunContext(derivationTx, {
      actionId: "derive-mixed",
      kind: "derivation",
    });
    const seen = input.withTx(derivationTx).get();
    doc.withTx(derivationTx).set({ a: seen!.value, b: seen!.value });
    expect((await derivationTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const link = doc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: link.id,
          patches: [{ op: "replace", path: "/value/b", value: 50 }],
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.committedEventIds).toEqual(["e-mixed"]);
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dispositions[1]).toEqual({ kind: "dropped" });
    // The authored b survives and the rebased a lands; the stale
    // derivation clobbered nothing.
    const stored = Engine.readState(engine, { id: link.id });
    expect(stored?.document).toEqual({ value: { a: 2, b: 50 } });
    // The Q1 corollary (§3d, RULED 2026-08-05): the dropped-write
    // SURVIVOR still lands its basis rows — its reads are true, and no
    // recompute-owed mark exists.
    const derivationBasis = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "derive-mixed",
      actionScopeKey: "space",
    });
    const inputLink = input.getAsNormalizedFullLink();
    expect(derivationBasis.find((row) => row.entity === inputLink.id))
      .toEqual({
        entitySpace: space,
        entity: inputLink.id,
        entityScopeKey: "space",
        seq: inputSeq,
      });
  });

  it("requeues a second handler whose patch overlaps the concurrent write, while the first handler's disjoint patch rebases", async () => {
    const lease = liveLease();

    const doc = runtime.getCell<{ a: number; b: number }>(
      space,
      "wave-two-handlers",
      undefined,
    );
    const seedTx = runtime.edit();
    doc.withTx(seedTx).set({ a: 1, b: 1 });
    expect((await seedTx.commit()).error).toBeUndefined();

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const firstTx = runtime.edit();
    stampWaveRunContext(firstTx, {
      actionId: "handle-a",
      kind: "event-handler",
      eventId: "e-first",
      acting: { user: "did:key:alice" },
    });
    doc.withTx(firstTx).key("a").set(2);
    expect((await firstTx.commit()).error).toBeUndefined();

    // The second handler patches /value/b — the SAME field the rival
    // writes — so its rebase conflicts semantically and it requeues.
    const secondTx = runtime.edit();
    stampWaveRunContext(secondTx, {
      actionId: "handle-b",
      kind: "event-handler",
      eventId: "e-second",
      acting: { user: "did:key:bob" },
    });
    doc.withTx(secondTx).key("b").set(7);
    expect((await secondTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const link = doc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: link.id,
          patches: [{ op: "replace", path: "/value/b", value: 50 }],
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.committedEventIds).toEqual(["e-first"]);
    expect(outcome.requeuedEventIds).toEqual(["e-second"]);
    // The rival's b stands; the raced consequence did not commit blind.
    const stored = Engine.readState(engine, { id: link.id });
    expect(stored?.document).toEqual({ value: { a: 2, b: 50 } });
  });

  /** C8d scenario: a requeued parent event with a same-wave cascade
   * child. The parent's whole-doc set races a rival (semantic conflict →
   * requeue); the child writes its own doc and reads NOTHING of the
   * parent's, so only the cascade closure ties their fates. */
  const runCascadeRequeueScenario = async () => {
    const lease = liveLease();
    const parentDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-cascade-parent",
      undefined,
    );
    const childDoc = runtime.getCell<{ value: number }>(
      space,
      "wave-cascade-child",
      undefined,
    );

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const parentTx = runtime.edit();
    stampWaveRunContext(parentTx, {
      actionId: "handle-cascade-parent",
      kind: "event-handler",
      eventId: "e-parent",
      acting: { user: "did:key:alice" },
    });
    parentDoc.withTx(parentTx).set({ value: 1 });
    expect((await parentTx.commit()).error).toBeUndefined();

    const childTx = runtime.edit();
    stampWaveRunContext(childTx, {
      actionId: "handle-cascade-child",
      kind: "event-handler",
      eventId: "e-child",
      parentEventId: "e-parent",
      acting: { user: "did:key:alice" },
    });
    childDoc.withTx(childTx).set({ value: 2 });
    expect((await childTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const parentLink = parentDoc.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: parentLink.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    return { outcome, childDoc };
  };

  it("folds a same-wave cascade child into its requeued parent's rollback (C8d closure)", async () => {
    const { outcome, childDoc } = await runCascadeRequeueScenario();

    // The child raced nothing itself — only the cascade closure rolls it
    // back with its parent. Its write must not land: the parent's re-run
    // re-mints the cascade, and a committed child would double it.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "requeued" },
    ]);
    expect(outcome.committedEventIds).toEqual([]);
    expect(outcome.seq).toBeUndefined();
    const childLink = childDoc.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: childLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("reports SURVIVING requeues only: a cascade child of a requeued parent has no durable entry to retry", async () => {
    const { outcome } = await runCascadeRequeueScenario();

    // The child rolled back WITH its parent (previous test), but the
    // serving loop must be told to retry only the PARENT: the cascade
    // child never got a durable stream entry — the parent's re-run
    // re-mints it with a fresh id — so reporting it would make the loop
    // retry an event that does not exist.
    expect(outcome.requeuedEventIds).toEqual(["e-parent"]);
  });

  it("drops a derivation that read a requeued handler's sealed write (nothing derived from withdrawn state commits)", async () => {
    const lease = liveLease();
    const consequence = runtime.getCell<{ value: number }>(
      space,
      "wave-requeued-consequence",
      undefined,
    );
    const derived = runtime.getCell<{ value: number }>(
      space,
      "wave-derived-from-requeued",
      undefined,
    );

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const handlerTx = runtime.edit();
    stampWaveRunContext(handlerTx, {
      actionId: "handle-withdrawn",
      kind: "event-handler",
      eventId: "e-withdrawn",
      acting: { user: "did:key:alice" },
    });
    consequence.withTx(handlerTx).set({ value: 5 });
    expect((await handlerTx.commit()).error).toBeUndefined();

    // The derivation READS the handler's sealed write through the
    // layered view, then writes its own doc.
    const deriveTx = runtime.edit();
    stampWaveRunContext(deriveTx, {
      actionId: "derive-from-withdrawn",
      kind: "derivation",
    });
    const seen = consequence.withTx(deriveTx).get();
    expect(seen).toEqual({ value: 5 });
    derived.withTx(deriveTx).set({ value: seen!.value + 1 });
    expect((await deriveTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // A rival whole-doc set races the consequence: semantic conflict, so
    // the handler REQUEUES (not a per-doc drop — the closure must fold
    // the reader in off the requeue arm specifically).
    const link = consequence.getAsNormalizedFullLink();
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: link.id,
          value: { value: { value: 1000 } },
        }],
      },
    });

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    // The derivation derived from state that will re-run later:
    // committing it would be §3d's forbidden blind derived write.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.requeuedEventIds).toEqual(["e-withdrawn"]);
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "dropped" },
    ]);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    const derivedLink = derived.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: derivedLink.id, scopeKey: "space" }),
    ).toBe(0);
  });

  it("re-resolves when the sink's in-transaction re-verification names a doc that moved after the head query", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const x = runtime.getCell<{ value: number }>(space, "wave-race", undefined);
    const keep = runtime.getCell<{ value: number }>(
      space,
      "wave-race-keep",
      undefined,
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "derive-race", kind: "derivation" });
    x.withTx(tx).set({ value: 1 });
    keep.withTx(tx).set({ value: 2 });
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    // The rival lands BETWEEN the accumulator's head query and the store
    // transaction: injected on the sink's first home commit attempt, so
    // only the engine's in-transaction re-verification can catch it.
    const xLink = x.getAsNormalizedFullLink();
    const inner = newSink();
    let homeAttempts = 0;
    const racingSink: WaveCommitSink = {
      currentHeads: (s, docs) => inner.currentHeads(s, docs),
      concurrentWritePaths: (s, doc, since) =>
        inner.concurrentWritePaths(s, doc, since),
      commitWave: (batch) => {
        homeAttempts += 1;
        if (homeAttempts === 1) {
          Engine.applyCommit(engine, {
            sessionId: "rival-session",
            principal: "user:rival",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: xLink.id,
                value: { value: { value: 99 } },
              }],
            },
          });
        }
        return inner.commitWave(batch);
      },
    };

    const outcome = await wave.commitWave(racingSink);
    await wave.settled();

    // Attempt 1 was rejected with the doc NAMED; the loop folded it in,
    // dropped the superseded write, and attempt 2 committed the rest.
    expect(homeAttempts).toBe(2);
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dispositions[0]).toEqual({
      kind: "partially-dropped",
      droppedOps: 1,
    });
    const stored = Engine.readState(engine, { id: xLink.id });
    expect(stored?.document).toEqual({ value: { value: 99 } });
    const keepLink = keep.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: keepLink.id, scopeKey: "space" }),
    ).toBe(outcome.seq);
  });

  it("resolves a sink-reported precondition failure per owning contribution, never whole-wave", async () => {
    const lease = liveLease();
    const guarded = runtime.getCell<{ value: number }>(
      space,
      "wave-guarded-out",
      undefined,
    );
    const independent = runtime.getCell<{ value: number }>(
      space,
      "wave-independent-out",
      undefined,
    );

    // The doc the handler's create-only gate targets, created by a rival
    // DIRECTLY against the engine: the replica never sees it, so only
    // the engine's in-transaction validation can catch the violation —
    // exactly the race the wave-side resolution loop exists for.
    const takenId = "of:wave-precondition-taken";
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: takenId,
          value: { value: { value: 1 } },
        }],
      },
    });

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const handlerTx = runtime.edit();
    stampWaveRunContext(handlerTx, {
      actionId: "handle-guarded",
      kind: "event-handler",
      eventId: "e-guarded",
      acting: { user: "did:key:alice" },
    });
    guarded.withTx(handlerTx).set({ value: 1 });
    // Non-null assert rather than `?.`: a silently skipped gate would
    // make this test vacuous — absence must throw.
    handlerTx.addCommitPrecondition!(space, {
      kind: "entity-absent",
      id: takenId,
    });
    expect((await handlerTx.commit()).error).toBeUndefined();

    const deriveTx = runtime.edit();
    stampWaveRunContext(deriveTx, {
      actionId: "derive-independent",
      kind: "derivation",
    });
    independent.withTx(deriveTx).set({ value: 2 });
    expect((await deriveTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    // Per-owning-contribution resolution: the handler REQUEUES on its
    // violated gate, the unrelated derivation COMMITS. A whole-wave
    // abort here would be §3d's forbidden whole-wave CAS failure shape.
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions).toEqual([
      { kind: "requeued" },
      { kind: "committed" },
    ]);
    expect(outcome.requeuedEventIds).toEqual(["e-guarded"]);
    expect(outcome.committedEventIds).toEqual([]);
    const guardedLink = guarded.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: guardedLink.id, scopeKey: "space" }),
    ).toBe(0);
    const independentLink = independent.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, {
        id: independentLink.id,
        scopeKey: "space",
      }),
    ).toBe(outcome.seq);
  });

  it("validates a preconditions-only wave instead of short-circuiting (a violated gate must not resolve committed)", async () => {
    const lease = liveLease();
    const takenId = "of:wave-preconditions-only-taken";
    Engine.applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: takenId,
          value: { value: { value: 1 } },
        }],
      },
    });

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const guardTx = runtime.edit();
    stampWaveRunContext(guardTx, {
      actionId: "derive-guard",
      kind: "derivation",
    });
    guardTx.addCommitPrecondition!(space, {
      kind: "entity-absent",
      id: takenId,
    });
    expect((await guardTx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    expect(wave.contributionCount).toBe(1);

    const seqBefore = Engine.serverSeq(engine);
    const outcome = await wave.commitWave(newSink());
    await wave.settled();

    // A home batch with 0 ops and 0 consequenceOf but a NON-EMPTY gate
    // must reach the sink: short-circuiting it resolves the contribution
    // committed (seq 0) with the gate never validated.
    expect(outcome.dispositions).toEqual([{ kind: "dropped" }]);
    expect(outcome.seq).toBeUndefined();
    expect(Engine.serverSeq(engine)).toBe(seqBefore);
  });

  it("attaches the explicit scope_key on a scoped write at seal time, and the engine keys the row by it", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const scoped = runtime.getCell<{ value: number }>(
      space,
      "wave-scoped",
      undefined,
      undefined,
      "user",
    );
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "handle-scoped",
      kind: "event-handler",
      eventId: "e-scoped",
      acting: { user: "did:key:alice", session: "sess-1" },
    });
    scoped.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();

    const expectedKey = Engine.resolveScopeKey("user", {
      principal: signer.did(),
      sessionId: "wave-test-session",
    });
    const row = engine.database.prepare(
      `SELECT annotations FROM "commit" WHERE seq = :seq`,
    ).get({ seq: outcome.seq }) as { annotations: string };
    const annotations = decodeMemoryBoundary(row.annotations) as Array<
      Record<string, unknown>
    >;
    const scopedAnnotation = annotations.find((a) => a.scopeKey !== undefined);
    expect(scopedAnnotation?.scopeKey).toBe(expectedKey);
    expect(scopedAnnotation?.actingUser).toBe("did:key:alice");
    const link = scoped.getAsNormalizedFullLink();
    const revision = engine.database.prepare(
      `SELECT scope_key FROM revision WHERE id = :id`,
    ).get({ id: link.id }) as { scope_key: string };
    expect(revision.scope_key).toBe(expectedKey);
  });

  it("replaces a same-instance action's basis rows with the LAST run's set within one wave", async () => {
    const lease = liveLease();

    const seedA = runtime.getCell<{ value: number }>(
      space,
      "wave-seed-a",
      undefined,
    );
    const seedB = runtime.getCell<{ value: number }>(
      space,
      "wave-seed-b",
      undefined,
    );
    const outA = runtime.getCell<{ value: number }>(
      space,
      "wave-out-a",
      undefined,
    );
    const outB = runtime.getCell<{ value: number }>(
      space,
      "wave-out-b",
      undefined,
    );
    for (const [cell, value] of [[seedA, 1], [seedB, 2]] as const) {
      const tx = runtime.edit();
      cell.withTx(tx).set({ value });
      expect((await tx.commit()).error).toBeUndefined();
    }

    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    // The same action instance runs twice in one wave (re-dirtied by a
    // later input); §3b's overwrite unit: the LAST run's rows replace
    // the first run's as a set — never a union.
    const run1 = runtime.edit();
    stampWaveRunContext(run1, { actionId: "recompute", kind: "derivation" });
    outA.withTx(run1).set({ value: seedA.withTx(run1).get()!.value + 1 });
    expect((await run1.commit()).error).toBeUndefined();
    const run2 = runtime.edit();
    stampWaveRunContext(run2, { actionId: "recompute", kind: "derivation" });
    outB.withTx(run2).set({ value: seedB.withTx(run2).get()!.value + 1 });
    expect((await run2.commit()).error).toBeUndefined();
    runtime.clearSealDestination();

    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();

    const basis = selectSchedulerBasisRows(engine, {
      branch: "",
      action: "recompute",
      actionScopeKey: "space",
    });
    const entities = basis.map((row) => row.entity);
    const seedALink = seedA.getAsNormalizedFullLink();
    const seedBLink = seedB.getAsNormalizedFullLink();
    expect(entities).toContain(seedBLink.id);
    expect(entities).not.toContain(seedALink.id);
  });

  it("isolates a failed seal to its own action (an aborted tx discards only its own writes)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const kept = runtime.getCell<{ value: number }>(
      space,
      "wave-kept",
      undefined,
    );
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-kept", kind: "derivation" });
    kept.withTx(tx1).set({ value: 1 });
    expect((await tx1.commit()).error).toBeUndefined();

    // The second action aborts before commit: it never reaches the wave.
    const dropped = runtime.getCell<{ value: number }>(
      space,
      "wave-aborted",
      undefined,
    );
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-drop", kind: "derivation" });
    dropped.withTx(tx2).set({ value: 2 });
    tx2.abort("test");

    expect(wave.contributionCount).toBe(1);
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.dispositions).toEqual([{ kind: "committed" }]);
    const keptLink = kept.getAsNormalizedFullLink();
    const droppedLink = dropped.getAsNormalizedFullLink();
    expect(
      Engine.selectDocHead(engine, { id: keptLink.id, scopeKey: "space" }),
    ).toBe(outcome.seq);
    expect(
      Engine.selectDocHead(engine, { id: droppedLink.id, scopeKey: "space" }),
    ).toBe(0);
  });
});
