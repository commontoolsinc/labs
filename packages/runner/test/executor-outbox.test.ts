// Server-execution v2 stage G: the outbox — both halves — and the
// stage-D sqlite bound's discharge (serving-loop.md §4–§6; FP1 RULED
// 2026-08-03). The executable spec model
// (packages/spec-model/server-execution) stays the oracle; these tests
// pin the same ruled semantics at the implementation layer:
//
// - effects hand to the outbox POST-commit, never at seal
//   (serving-loop.md §3): a destination that defers takes the sealed
//   tx's post-commit effects, and the inline flush is skipped; a
//   destination without the hook keeps today's inline flush;
// - the EFFECT half is process-local with in-flight dedupe per key
//   (§4/§5): a second admit of a live id attaches, counters count
//   (§7's memo/outbox blocks), and the run-context carriage captured
//   at seal is retrievable until the work settles;
// - the DURABLE half (FP1): outbound append rows land INSIDE the
//   wave's own engine transaction, only for SURVIVING contributions;
//   delivery admits at the target under the delegated row — `firedAt`
//   from the CARRIED actor, the envelope the service session (LT5) —
//   then deletes the row (admit-before-delete, so a crash between the
//   two re-sends and the target's eventId horizon dedupes: the model's
//   C2/FP1 closure — no schedule loses an append); an LT4
//   deterministic rejection deletes without retrying;
// - sqlite ops in HOME wave batches attach their cell-db through the
//   memory server's wave hook and apply atomically with the wave's
//   cell ops; a sink without the hook, a batch without per-op scope
//   keys, and a FOREIGN batch with sqlite ops are all refused loudly.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import { table } from "@commonfabric/memory/sqlite/schema";
import { runQuery } from "@commonfabric/memory/sqlite/exec";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveSpaceCommit,
} from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { SpaceOutbox } from "../src/executor/outbox.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

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

const signer = await Identity.fromPassphrase("executor outbox test");
const space = signer.did() as MemorySpace;
const targetSigner = await Identity.fromPassphrase("executor outbox target");
const targetSpace = targetSigner.did() as MemorySpace;

describe("stage G outbox + sqlite discharge", () => {
  let server: MemoryV2Server.Server;
  let storageManager: SharedServerStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;
  /** One process-lifetime counter per test, shared by every sink and
   * outbox (the replay-keying discipline — engine-wave-sink.ts). */
  let localSeqRef: { value: number };

  const holder = executionLeaseHolder(`service:${space}`);

  const newWave = (options: {
    lease?: ConstructorParameters<typeof WaveAccumulator>[0]["lease"];
  } = {}): WaveAccumulator =>
    new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "outbox-test-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      ...(options.lease !== undefined ? { lease: options.lease } : {}),
    });

  const newSink = (
    options: {
      sqliteAttachmentsFor?: ConstructorParameters<
        typeof EngineWaveCommitSink
      >[0]["sqliteAttachmentsFor"];
    } = {},
  ): EngineWaveCommitSink =>
    new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: holder,
      localSeqRef,
      ...(options.sqliteAttachmentsFor !== undefined
        ? { sqliteAttachmentsFor: options.sqliteAttachmentsFor }
        : {}),
    });

  const liveLease = (): ExecutionLeaseCycle => {
    const cycle = new ExecutionLeaseCycle({ engine, space, holder });
    if (!cycle.acquire()) throw new Error("test lease acquire failed");
    return cycle;
  };

  const newOutbox = (
    stats = emptyServingLoopStats(),
  ): {
    outbox: SpaceOutbox;
    stats: ReturnType<typeof emptyServingLoopStats>;
  } => ({
    outbox: new SpaceOutbox({
      stats,
      server,
      engine,
      sessionId: holder,
      localSeqRef,
    }),
    stats,
  });

  beforeEach(async () => {
    localSeqRef = { value: 0 };
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

  // ---- the effect handoff at the seal destination ----

  it("defers a sealed tx's post-commit effects to the destination; without the hook the inline flush stays (serving-loop.md §3)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    const deferred: PostCommitSideEffect[][] = [];
    // A destination that OWNS effects: wave sealing plus the stage-G
    // defer hook (the SpaceServer's shape, minus the loop).
    const deferringDestination: TransactionSealDestination = {
      seal: (tx: IExtendedStorageTransaction) => wave.seal(tx),
      deferSealedEffects: (
        _tx: IExtendedStorageTransaction,
        effects: readonly PostCommitSideEffect[],
      ) => {
        deferred.push([...effects]);
        return true;
      },
    };
    runtime.installSealDestination(deferringDestination);

    const doc = runtime.getCell<{ value: number }>(
      space,
      "outbox-defer",
      undefined,
    );
    let flushed = 0;
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "derive-defer", kind: "derivation" });
    doc.withTx(tx).set({ value: 1 });
    tx.enqueuePostCommitEffect({
      id: "fetchTest:hash-1",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    });
    expect((await tx.commit()).error).toBeUndefined();

    // NOT flushed at seal: the destination took the effects (post-commit
    // handoff is the wave cycle's duty, not the seal's).
    expect(flushed).toBe(0);
    expect(deferred.length).toBe(1);
    expect(deferred[0].map((effect) => effect.id)).toEqual([
      "fetchTest:hash-1",
    ]);
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.seq).toBeDefined();

    // Contrast: a destination WITHOUT the hook keeps today's inline
    // flush at seal — bare accumulators (stage-D tests) unchanged.
    const wave2 = newWave({ lease });
    runtime.installSealDestination(wave2);
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-inline", kind: "derivation" });
    doc.withTx(tx2).set({ value: 2 });
    tx2.enqueuePostCommitEffect({
      id: "fetchTest:hash-2",
      kind: "fetchTest-start",
      flush: () => {
        flushed += 1;
      },
    });
    expect((await tx2.commit()).error).toBeUndefined();
    expect(flushed).toBe(1);
    runtime.clearSealDestination();
    wave2.abandon("test over");
    lease.release();
  });

  // ---- the process-local effect half ----

  it("admits sealed effects post-commit with in-flight dedupe per key; counters and carriage are live (serving-loop.md §4–§5, §7)", async () => {
    const { outbox, stats } = newOutbox();
    let ran = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = (id: string): PostCommitSideEffect => ({
      id,
      kind: "fetchTest-start",
      flush: () => {
        ran += 1;
        // The builtin shape: the flush starts work synchronously and
        // returns; the WORK is what completion tracks.
        outbox.observeAsyncWork(gate);
      },
    });
    const tx = {} as IExtendedStorageTransaction;
    const context = {
      actionId: "fetch-node",
      kind: "derivation" as const,
      acting: { user: "user:alice", session: "sess-1" },
    };
    outbox.admitSealedEffects([{
      tx,
      effects: [effect("fetchTest:key-A")],
      context,
    }]);
    // §4's in-flight dedupe: a second miss on the same key attaches —
    // the callback runs once.
    outbox.admitSealedEffects([{
      tx,
      effects: [effect("fetchTest:key-A")],
      context: undefined,
    }]);
    expect(ran).toBe(1);
    expect(stats.outbox.queued).toBe(1);
    expect(stats.memo.misses).toBe(1);
    expect(stats.memo.inflight).toBe(1);
    // The §4 identity carriage, captured at the original run's seal, is
    // live while the effect is — the completion committer's annotation
    // source.
    expect(outbox.carriageFor("fetchTest:key-A")?.acting?.user).toBe(
      "user:alice",
    );

    release!();
    await outbox.settle();
    expect(stats.outbox.completed).toBe(1);
    expect(stats.outbox.failed).toBe(0);
    expect(stats.memo.inflight).toBe(0);
    // Carriage retires with the work (a late straggler falls back to
    // the wave identity, which is the same identity in Phase 1).
    expect(outbox.carriageFor("fetchTest:key-A")).toBeUndefined();
  });

  it("counts infrastructure failures as outbox.failed (a flush throw); effect-level failures are error-shaped RESULTS, not failures (§4)", async () => {
    const { outbox, stats } = newOutbox();
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: [{
        id: "fetchTest:throws",
        kind: "fetchTest-start",
        flush: () => {
          throw new Error("flush infrastructure broke");
        },
      }],
      context: undefined,
    }]);
    await outbox.settle();
    expect(stats.outbox.failed).toBe(1);
    expect(stats.outbox.completed).toBe(0);
  });

  // ---- the durable half: rows in the wave's own transaction (FP1) ----

  it("lands outbound append rows INSIDE the wave's engine transaction, for surviving contributions only (FP1; the model's committed-only fold)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);

    const x = runtime.getCell<{ value: number }>(space, "append-x", undefined);
    const z = runtime.getCell<{ value: number }>(space, "append-z", undefined);

    // Contribution 1: writes x and stages an append. Its x write will be
    // SUPERSEDED per-doc — and per §3d (RULED 2026-08-05) the drop
    // re-arms nothing, so nothing would ever re-run this producer to
    // re-emit: like its basis rows ("its reads are true"), its append
    // MUST still ride the wave.
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 10 });
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: "of:target-stream",
      eventId: "evt-1",
      payload: { note: "from contribution 1" },
      actingPrincipal: "user:alice",
      actingSession: "sess-1",
      capabilityRef: "cap-1",
    });
    expect((await tx1.commit()).error).toBeUndefined();

    // Contribution 2: READS contribution 1's withdrawn x write — it is
    // withdrawn WHOLE (nothing derived from withdrawn state commits),
    // and its own reads re-run it when fresh state lands. Its append
    // must NOT become a durable row: the re-run re-emits it (the
    // model's committed-only cascadesCross fold).
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-z", kind: "derivation" });
    const seen = x.withTx(tx2).get();
    z.withTx(tx2).set({ value: seen!.value + 1 });
    wave.enqueueOutboundAppend(tx2, {
      targetSpace,
      targetStream: "of:target-stream",
      eventId: "evt-lost",
      payload: {},
      actingPrincipal: "user:bob",
      capabilityRef: "cap-2",
    });
    expect((await tx2.commit()).error).toBeUndefined();

    // A concurrent authored commit moves x's head past the wave basis.
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
    expect(wave.hasOutboundAppends).toBe(true);
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    // Contribution 1: per-doc superseded (its only doc — disposition
    // "dropped" via the all-dropped path) yet still a structural
    // survivor: basis rows and appends ride. Contribution 2:
    // dependency-dropped whole — excluded.
    expect(outcome.supersededWrites).toBe(1);
    expect(outcome.dependencyDroppedWrites).toBe(1);
    // The batch had no surviving ops but DID carry appends: the
    // appends-only wave commit is not short-circuited (FP1 — the rows
    // land inside a real wave transaction).
    expect(outcome.seq).toBeDefined();

    const rows = selectPendingExecutionOutboxRows(engine, { branch: "" });
    expect(rows.length).toBe(1);
    expect(rows[0].eventId).toBe("evt-1");
    expect(rows[0].targetSpace).toBe(targetSpace);
    expect(rows[0].actingPrincipal).toBe("user:alice");
    expect(rows[0].actingSession).toBe("sess-1");
    expect(rows[0].capabilityRef).toBe("cap-1");
    expect(rows[0].createdSeq).toBe(outcome.seq);
    lease.release();
  });

  // ---- delivery: admit at the target, then delete (FP1 closure) ----

  it("delivers pending rows: delegated admission at the target stamps firedAt from the CARRIED actor (LT5 envelope), then deletes the row; a re-sent duplicate dedupes at the eventId horizon", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const x = runtime.getCell<{ value: number }>(space, "deliver-x", undefined);
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 1 });
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: "of:deliver-stream",
      eventId: "evt-d1",
      payload: { n: 7 },
      actingPrincipal: "user:alice",
      actingSession: "sess-1",
      capabilityRef: "cap-d",
    });
    expect((await tx1.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    const outcome = await wave.commitWave(newSink());
    await wave.settled();
    expect(outcome.seq).toBeDefined();

    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();

    // Delivered: the target stream doc holds the entry, firedAt from
    // the CARRIED actor — never the delivering envelope (protocol.md
    // §2's delegated stamping; the silent-empty-instance trap stays
    // closed) — and the delivery commit's envelope session is the
    // service holder (LT5), class authored.
    const targetEngine = await server.engineForSpace(targetSpace);
    const doc = Engine.read(targetEngine, { id: "of:deliver-stream" });
    const entries =
      (doc?.value as { entries?: Array<Record<string, unknown>> })?.entries ??
        [];
    expect(entries.length).toBe(1);
    expect(entries[0].eventId).toBe("evt-d1");
    expect(entries[0].payload).toEqual({ n: 7 });
    expect(entries[0].firedAt).toEqual({
      user: "user:alice",
      session: "sess-1",
    });
    const commitRow = targetEngine.database.prepare(
      `SELECT class, session_id, acting_principal, capability_ref
       FROM "commit" ORDER BY seq DESC LIMIT 1`,
    ).get() as {
      class: string;
      session_id: string;
      acting_principal: string;
      capability_ref: string;
    };
    expect(commitRow.class).toBe("authored");
    expect(commitRow.session_id).toContain(`service:${space}`);
    expect(commitRow.acting_principal).toBe("user:alice");
    expect(commitRow.capability_ref).toBe("cap-d");

    // Delivery-ack: the row is gone (a queue that empties).
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);

    // The crash window between admit and delete: simulate by
    // re-inserting the SAME row (as a re-send would find it) and
    // delivering again — the duplicate dedupes at the target's eventId
    // horizon (no second entry) and the row still retires.
    const lease2 = liveLease();
    const wave2 = newWave({ lease: lease2 });
    runtime.installSealDestination(wave2);
    const tx2 = runtime.edit();
    stampWaveRunContext(tx2, { actionId: "derive-x2", kind: "derivation" });
    x.withTx(tx2).set({ value: 2 });
    wave2.enqueueOutboundAppend(tx2, {
      targetSpace,
      targetStream: "of:deliver-stream",
      eventId: "evt-d1",
      payload: { n: 7 },
      actingPrincipal: "user:alice",
      actingSession: "sess-1",
      capabilityRef: "cap-d",
    });
    expect((await tx2.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    expect((await wave2.commitWave(newSink())).seq).toBeDefined();
    await wave2.settled();
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);
    // A fresh outbox instance (the recovering process — §6 step 5's
    // re-send): the durable row survived, the effect half did not need
    // to.
    const { outbox: recovered } = newOutbox();
    await recovered.deliverPendingAppends();
    const after = Engine.read(targetEngine, { id: "of:deliver-stream" });
    const afterEntries =
      (after?.value as { entries?: Array<unknown> })?.entries ?? [];
    expect(afterEntries.length).toBe(1);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(0);
    lease.release();
    lease2.release();
  });

  it("does not retry an LT4 deterministic admission rejection: the row is deleted and counted failed (a userless row trips the delegated completeness floor)", async () => {
    const lease = liveLease();
    const wave = newWave({ lease });
    runtime.installSealDestination(wave);
    const x = runtime.getCell<{ value: number }>(space, "lt4-x", undefined);
    const tx1 = runtime.edit();
    stampWaveRunContext(tx1, { actionId: "derive-x", kind: "derivation" });
    x.withTx(tx1).set({ value: 1 });
    // No actingPrincipal: the engine's delegated admission floor
    // requires actor + grant (protocol.md §2), so delivery rejects
    // DETERMINISTICALLY. (Space-scope derivation emissions are a
    // Phase 3+ producer; their delegated-floor treatment is flagged in
    // the stage-G PR.)
    wave.enqueueOutboundAppend(tx1, {
      targetSpace,
      targetStream: "of:lt4-stream",
      eventId: "evt-lt4",
      payload: {},
      capabilityRef: "cap-x",
    });
    expect((await tx1.commit()).error).toBeUndefined();
    runtime.clearSealDestination();
    expect((await wave.commitWave(newSink())).seq).toBeDefined();
    await wave.settled();

    const { outbox, stats } = newOutbox();
    await outbox.deliverPendingAppends();
    // LT4: not retried — the row is retired, the failure counted; the
    // source-side failure notice is Phase 3's events.md §5 machinery.
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(1);
    const targetEngine = await server.engineForSpace(targetSpace);
    expect(Engine.read(targetEngine, { id: "of:lt4-stream" })).toBeNull();
    lease.release();
  });

  // ---- the sqlite bound's discharge ----

  // Unique per test run: the cell-db FILE for a memory-URL engine lives
  // at a deterministic TMPDIR path keyed by (space, id) — a stable id
  // would accrete rows across suite runs.
  const SQLITE_DB_ID = `of:wave-cell-db-${crypto.randomUUID()}`;
  const SQLITE_TABLES = {
    messages: table({ id: "integer primary key", body: "text" }),
  };

  const sqliteBatch = (options: {
    home?: boolean;
    scopeKeys?: ReadonlyArray<{ op: number; scopeKey: "space" }>;
    holder?: string;
  } = {}): WaveSpaceCommit => ({
    space,
    home: options.home ?? true,
    basisSeq: Engine.serverSeq(engine),
    rebasedHeads: [],
    operations: [
      {
        op: "set",
        id: "of:wave-sqlite-cell",
        value: { value: { ok: true } },
      },
      {
        op: "sqlite",
        db: { id: SQLITE_DB_ID, tables: SQLITE_TABLES },
        sql: "INSERT INTO messages (body) VALUES (?)",
        params: ["from the wave"],
      },
    ],
    preconditions: [],
    annotations: [],
    consequenceOf: [],
    basisInstances: [],
    holder: options.holder ?? holder,
    ...(options.scopeKeys === undefined
      ? { sqliteScopeKeys: [{ op: 1, scopeKey: "space" }] }
      : { sqliteScopeKeys: options.scopeKeys }),
  });

  it("applies a folded sqlite op in a HOME wave batch atomically via the server's attachment hook (the stage-D bound discharged)", async () => {
    const lease = liveLease();
    const sink = newSink({
      sqliteAttachmentsFor: (s, operations, scopeKeyByOpIndex) =>
        server.attachWaveCommitSqliteDbs(
          engine,
          s,
          operations,
          scopeKeyByOpIndex,
        ),
    });
    const result = await sink.commitWave(sqliteBatch());
    expect(result.error).toBeUndefined();

    // Both halves landed atomically: the cell write in the store, the
    // row in the (space-scoped) cell-db file.
    expect(
      Engine.read(engine, { id: "of:wave-sqlite-cell" }),
    ).toEqual({ value: { ok: true } });
    const attached = server.attachWaveCommitSqliteDbs(
      engine,
      space,
      [{
        op: "sqlite",
        db: { id: SQLITE_DB_ID, tables: SQLITE_TABLES },
        sql: "SELECT 1",
      }],
      new Map([[0, "space"]]),
    );
    try {
      expect(runQuery(engine.database, "SELECT body FROM messages")).toEqual([
        { body: "from the wave" },
      ]);
    } finally {
      attached.detach();
    }
    lease.release();
  });

  it("refuses a sqlite-carrying batch loudly on a sink without the attachment hook, on a batch without per-op scope keys, and on a FOREIGN batch", async () => {
    const lease = liveLease();
    // No hook: refused, never silently applied.
    const bare = await newSink().commitWave(sqliteBatch());
    expect(bare.error?.message).toContain("no attachment hook");

    // Hook present but no resolved scope key for the op: the server
    // helper refuses (the accumulator resolves every sqlite op's scope
    // against its run's identity — a missing entry is a plumbing bug).
    const hooked = newSink({
      sqliteAttachmentsFor: (s, operations, scopeKeyByOpIndex) =>
        server.attachWaveCommitSqliteDbs(
          engine,
          s,
          operations,
          scopeKeyByOpIndex,
        ),
    });
    const keyless = await hooked.commitWave(
      sqliteBatch({ scopeKeys: [] }),
    );
    expect(keyless.error?.message).toContain("no resolved scope key");

    // Foreign batch: Phase 5's cross-space design owns it.
    const foreign = await hooked.commitWave(
      sqliteBatch({ home: false }),
    );
    expect(foreign.error?.message).toContain("FOREIGN wave batch");
    lease.release();
  });
});
