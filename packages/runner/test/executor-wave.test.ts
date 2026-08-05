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
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, Result } from "../src/storage/interface.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveCommitRejection,
  type WaveCommitSink,
} from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// Shared-server helper (modelled after cell-cache.test.ts): the test needs
// the SERVER's engines — the wave commit sink runs against the co-hosted
// engine — so the server is constructed outside the manager.
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
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const signer = await Identity.fromPassphrase("executor wave test");
const space = signer.did() as MemorySpace;

describe("stage D seal-into-wave", () => {
  let server: MemoryV2Server.Server;
  let storageManager: SharedServerStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;

  const newWave = (options: {
    lease?: ConstructorParameters<typeof WaveAccumulator>[0]["lease"];
  } = {}): WaveAccumulator =>
    new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      // OFF-arm cardinality 1: the instance keys derive from the
      // runtime's own authenticated session (plan Phase 1 stage E).
      resolveScopeKey: (scope) =>
        Engine.resolveScopeKey(scope, {
          principal: signer.did(),
          sessionId: "wave-test-session",
        }),
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
    storageManager = SharedServerStorageManager.connectTo(server, {
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
    const offManager = SharedServerStorageManager.connectTo(server, {
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
