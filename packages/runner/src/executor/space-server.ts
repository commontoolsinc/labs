// The SpaceServer (server-execution v2 stage F, serving-loop.md §1, §3):
// one committing runtime per ACTIVE space. It owns the lease (renewed on
// a timer — stage B's cycle finally gets its cadence), the serving
// Runtime (flag ON, builtins registered, the pattern-update posture
// flipped server-side — §3e), the accepted-commit subscription (the
// host's in-process feed — plane (d)), and the wave loop: wake on
// accepted commit, run the affected graph to fixpoint through the
// stage-D wave machinery, commit ONE derived transaction per wave
// carrying the watermark (protocol.md §4).
//
// What activation LOADS (RULED 2026-08-02): there is NO piece-start
// policy. The space is one lazy reactive graph; activation loads graph
// structure sufficient to resolve the DEMANDED values (client
// subscriptions — the server's watch registry) and queued events — via
// `ensurePieceRunning`, the sanctioned prior art (the no-handler
// auto-load path), per demanded root, never "instantiate the pieces" as
// a step of its own. Undemanded derivations stay dirty-unmaterialized
// indefinitely.
//
// Phase-1 bounds, stated (the stage cut, plan Phase 1):
// - no events on the wire until Phase 3 (the event seam exists in the
//   wave machinery; this loop has no producers to drain), so
//   `events.*` counters stay 0 and the activation criterion
//   "undelivered events" has no instances yet;
// - demand at OFF-arm cardinality: per-run demanded identities plug in
//   at `#stampRun` (M1's seam); in Phase 1 the loop serves the graph
//   under its wave identity.
//
// Stage G lands the effect channel (serving-loop.md §4–§5): sealed
// post-commit effects defer to the per-space outbox and fire after the
// wave commit; effectful builtins' writebacks — marked with their
// effect key — commit as their OWN derived-class COMPLETION commits
// (never through the wave: §4's "never passes through §3d's sealing"),
// annotated from the outbox carriage captured at the original run's
// seal; the durable outbound-append rows deliver and retire through
// the outbox; `memo.*`/`outbox.*` counters are live.

import {
  type AdmittedCommitNotice,
  type Server as MemoryServer,
} from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  EXECUTION_LEASE_RENEW_INTERVAL_MS,
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { selectStaleBasisInstances } from "@commonfabric/memory/v2/scheduler-basis";
import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime, ServerRunInfo } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  TransactionSealDestination,
  Unit,
} from "../storage/interface.ts";
import type { CommitError } from "../storage/interface.ts";
import { ensurePieceRunning } from "../ensure-piece-running.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveRunContextOf,
  type WaveWriteAnnotation,
} from "./wave.ts";
import { EngineWaveCommitSink } from "./engine-wave-sink.ts";
import { readWatermarkSeq, watermarkCell } from "./watermark.ts";
import type { ServingLoopStats } from "./stats.ts";
import { type SealedEffectBatch, SpaceOutbox } from "./outbox.ts";
import { effectCompletionKeyOf } from "./effect-completion.ts";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import type { PostCommitSideEffect } from "../cfc/types.ts";

const logger = getLogger("space-server", { enabled: true, level: "warn" });

/** The sanctioned internal stamp kind's durable action id (serving-loop.md
 * §3d, RULED 2026-08-05: stage F names the kinds when it installs the
 * seal destination). */
const WATERMARK_ACTION_ID = "server-execution/watermark";

export type SpaceServerPolicy = {
  /** serving-loop.md §3's consequence-flush deadline T_flush (order
   * 50–100 ms; a policy knob tuned in Phase 6). */
  flushDeadlineMs?: number;
  /** serving-loop.md §1's IDLE_PARK_MS. */
  idleParkMs?: number;
  renewIntervalMs?: number;
};

export type SpaceServerOptions = {
  space: MemorySpace;
  server: MemoryServer;
  engine: Engine.Engine;
  /** The service identity (DID) the DR1 holder is minted from — also the
   * loopback session's principal, which is what the read-row admission
   * matches (protocol.md §2). */
  serviceIdentity: string;
  /** Build the serving runtime over the LOOPBACK storage plane
   * (serving-loop.md §1 plane (a)). The factory owns auth and options;
   * the SpaceServer asserts the posture (flag ON) and flips the
   * pattern-update posture is the factory's duty (§3e — pass
   * `systemPatternAutoUpdate: true`). */
  createRuntime: () => Promise<{
    runtime: Runtime;
    dispose: () => Promise<void>;
  }>;
  /** The process-lifetime localSeq counter for this space's wave sink
   * (engine-wave-sink.ts's replay keying — the host owns it). */
  localSeqRef: { value: number };
  /** The host's shared counters (serving-loop.md §7). */
  stats: ServingLoopStats;
  policy?: SpaceServerPolicy;
  onParked?: (reason: string) => void;
};

const DEFAULT_FLUSH_DEADLINE_MS = 100;
const DEFAULT_IDLE_PARK_MS = 30_000;

/**
 * One space's serving loop. The SpaceServer IS the seal destination — a
 * stable dispatcher over rotating wave accumulators, so an action tx
 * that commits between waves opens the next wave rather than erroring
 * (natural double-buffering: commits arriving mid-wave belong to the
 * NEXT wave, serving-loop.md §3).
 */
export class SpaceServer implements TransactionSealDestination {
  readonly #options: SpaceServerOptions;
  readonly #holder: string;
  #lease: ExecutionLeaseCycle | undefined;
  #runtime: Runtime | undefined;
  #disposeRuntime: (() => Promise<void>) | undefined;
  #sink: EngineWaveCommitSink | undefined;
  #renewTimer: ReturnType<typeof setInterval> | undefined;
  #currentWave: WaveAccumulator | undefined;
  #sealChain: Promise<unknown> = Promise.resolve();
  #feed: AdmittedCommitNotice[] = [];
  #feedArrived: PromiseWithResolvers<void> | undefined;
  #inputHead = 0;
  /** Highest NON-self-echo seq drained — the watermark's advance
   * target. The loop's own derived commits return on the feed above W
   * and must not count as coverage-owed input, or every wave commit
   * would trigger a watermark-only successor chasing its own seq — a
   * self-inflicted commit storm (the v1 failure class §7's
   * amplification budget exists to catch). */
  #coverageHead = 0;
  #watermark = 0;
  #active = false;
  #loopRunning = false;
  #parkRequested = false;
  readonly #parked = Promise.withResolvers<void>();
  #idleSince: number | undefined;
  #demandedRoots = new Set<string>();
  /** Live readers per demanded root — DEMAND ITSELF (serving-loop.md
   * §1: "a subscription to a value recomputes that value and its
   * upstream"): the sink is what pulls the demanded value through the
   * scheduler's pull-based laziness. Released on park. */
  readonly #demandSinks = new Map<string, () => void>();
  /** The stage-G effect channel (serving-loop.md §4–§5). */
  #outbox: SpaceOutbox | undefined;
  /** A drain left undelivered rows behind (transport-class failure):
   * the next wave cycle re-drains even without fresh appends. */
  #outboxDrainOwed = false;
  /** Post-commit effects of sealed transactions, deferred per wave
   * (serving-loop.md §3: effects hand to the outbox POST-commit, never
   * at seal). Admitted to the outbox after the wave's commit step;
   * discarded when the wave is abandoned (the park path — the runtime
   * dies with it, the crash-equivalent covered by memo re-miss). */
  readonly #pendingEffectsByWave = new Map<
    WaveAccumulator,
    SealedEffectBatch[]
  >();
  /** Which wave each sealed tx closed into — set at seal, consumed by
   * deferSealedEffects (which runs after the seal resolved, when the
   * wave may already have rotated). */
  readonly #waveByTx = new WeakMap<object, WaveAccumulator>();

  constructor(options: SpaceServerOptions) {
    this.#options = options;
    this.#holder = executionLeaseHolder(options.serviceIdentity);
  }

  get space(): MemorySpace {
    return this.#options.space;
  }

  get holder(): string {
    return this.#holder;
  }

  get active(): boolean {
    return this.#active;
  }

  get watermark(): number {
    return this.#watermark;
  }

  /** Resolves when this SpaceServer has fully parked (lease released,
   * runtime disposed). The host chains re-activation on it when a
   * session-open or admission races a park in progress. */
  get whenParked(): Promise<void> {
    return this.#parked.promise;
  }

  /** Store head minus W — the per-space input to §7's watermarkLag. */
  get watermarkLag(): number {
    return Math.max(
      0,
      Engine.serverSeq(this.#options.engine) - this.#watermark,
    );
  }

  /**
   * Activate (serving-loop.md §3 "on activate"): acquire the lease (else
   * park), build the serving runtime, read W, re-mark the dirty frontier
   * from the basis index, and subscribe from the head the index scan ran
   * against — the host feeds records from its admission observer, and
   * records at or below the scan head are covered by the re-mark.
   */
  async activate(): Promise<boolean> {
    if (this.#active) return true;
    const { engine, space } = this.#options;
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: this.#holder,
    });
    if (!lease.acquire()) {
      this.#options.onParked?.("lease-unavailable");
      return false;
    }
    this.#lease = lease;
    this.#options.stats.lease.held += 1;

    let runtime: Runtime;
    let dispose: () => Promise<void>;
    try {
      ({ runtime, dispose } = await this.#options.createRuntime());
    } catch (error) {
      // A failed activation must not strand the acquired lease row for
      // the TTL — a successor (or this host's retry) should be able to
      // acquire immediately.
      lease.release();
      this.#lease = undefined;
      throw error;
    }
    if (runtime.experimental.serverExecution !== true) {
      await dispose();
      lease.release();
      this.#lease = undefined;
      throw new Error(
        "SpaceServer runtime must run with serverExecution enabled " +
          "(serving-loop.md §3: flag ON, server posture)",
      );
    }
    this.#runtime = runtime;
    this.#disposeRuntime = dispose;
    this.#sink = new EngineWaveCommitSink({
      engineFor: (s) => s === space ? engine : this.#foreignEngineFor(s),
      sessionId: this.#holder,
      localSeqRef: this.#options.localSeqRef,
      // The stage-G sqlite discharge: folded sqlite ops in wave batches
      // attach their cell-db file(s) through the memory server's own
      // machinery (same validations as the transact path), keyed by the
      // accumulator's per-run scope keys.
      sqliteAttachmentsFor: (s, operations, scopeKeyByOpIndex) =>
        this.#options.server.attachWaveCommitSqliteDbs(
          s === space ? engine : this.#foreignEngineFor(s),
          s,
          operations,
          scopeKeyByOpIndex,
        ),
    });
    // The effect channel (stage G, serving-loop.md §4–§5).
    const outbox = new SpaceOutbox({
      stats: this.#options.stats,
      server: this.#options.server,
      engine,
      sessionId: this.#holder,
      localSeqRef: this.#options.localSeqRef,
    });
    this.#outbox = outbox;
    runtime.asyncWorkObserver = (work) => outbox.observeAsyncWork(work);
    runtime.effectMemoObserver = () => {
      this.#options.stats.memo.hits += 1;
    };

    // W = read watermark doc (0 if absent).
    this.#watermark = readWatermarkSeq(engine);

    // Recovery/warm start are the same move (serving-loop.md §6 step 2):
    // the activation scan computes the stale (action, instance) set
    // from the basis index and SURFACES it (counted, logged). Phase-1
    // truth, stated plainly: the scan does not yet seed scheduler
    // dirtiness — a fresh runtime holds no materialized graph to mark,
    // and recovery CORRECTNESS rides recompute-on-demand (a demanded
    // pull recomputes regardless, which is what makes the fresh-start
    // path sound). The index's skip-still-current warm-start VALUE
    // materializes when a later stage carries a materialized graph
    // across activation.
    const scanHead = Engine.serverSeq(engine);
    const { stale, foreignReadInstances } = selectStaleBasisInstances(
      engine,
      { branch: "", space },
    );
    if (foreignReadInstances.length > 0) {
      logger.warn("basis-foreign-rows", () => [
        `${foreignReadInstances.length} basis instance(s) carry ` +
        "cross-space reads; cross-space re-marking lands with Phase 5",
      ]);
    }
    logger.info?.("activate", () => [
      `space ${space} activated: W=${this.#watermark} scanHead=${scanHead} ` +
      `staleInstances=${stale.length}`,
    ]);
    // Subscribe from the scan head: drop queued records the scan covers.
    this.#feed = this.#feed.filter((record) => record.seq > scanHead);
    this.#inputHead = Math.max(this.#inputHead, scanHead, this.#watermark);
    this.#coverageHead = Math.max(this.#coverageHead, scanHead);

    // serving-loop.md §6 step 5: RE-SEND pending durable outbound-append
    // rows — a crash between a wave commit (which wrote the rows) and
    // their delivery re-sends here; duplicates dedupe at the target's
    // eventId horizon. Co-hosted delivery is an engine commit, not a
    // network await.
    try {
      await outbox.deliverPendingAppends();
    } catch (error) {
      logger.warn("activation-resend-failed", () => [
        "outbox re-send on activation failed; rows kept for the next " +
        "drain (serving-loop.md §6 step 5)",
        error,
      ]);
    }

    // The seal destination + the §3d run stamper (stage F names the
    // sanctioned internal stamp kinds when installing the destination:
    // "bookkeeping", used by the watermark write below).
    runtime.installSealDestination(this, {
      runStamper: (tx, info) => this.#stampRun(tx, info),
    });

    // Stage B's renew cadence, finally driven (serving-loop.md §2).
    const renewMs = this.#options.policy?.renewIntervalMs ??
      EXECUTION_LEASE_RENEW_INTERVAL_MS;
    this.#renewTimer = setInterval(() => this.#renew(), renewMs);

    this.#active = true;
    this.#options.stats.activeSpaces += 1;
    void this.#loop();
    return true;
  }

  #foreignEngineFor(_space: MemorySpace): Engine.Engine {
    // Cross-space serving is Phase 5; Phase 1 waves write their home
    // space only (no provisioning producers exist yet).
    throw new Error(
      "cross-space wave commits are Phase 5 (protocol.md §2b); no " +
        "Phase-1 producer writes a foreign space",
    );
  }

  /** The host's in-process feed (plane (d)): every admitted commit for
   * this space, own derived commits included (skipped by class + holder
   * below — serving-loop.md §3's self-echo rule). */
  enqueueCommit(record: AdmittedCommitNotice): void {
    this.#feed.push(record);
    this.#feedArrived?.resolve();
  }

  /** A session opened or its demand may have changed: reconsider the
   * demanded roots on the next cycle. */
  noteDemandChanged(): void {
    this.#feedArrived?.resolve();
  }

  // ---- TransactionSealDestination ----

  seal(tx: IExtendedStorageTransaction): Promise<Result<Unit, CommitError>> {
    // Effect-COMPLETION routing (stage G, serving-loop.md §4): a marked
    // writeback of a served effect commits as its OWN derived-class
    // commit — it never enters a wave (§4's "never passes through §3d's
    // sealing"; the run is long over when the response arrives, so no
    // stamp exists to seal under). Serialized on the same chain as wave
    // seals: both mutate the replica overlay through sealNative.
    const completionKey = effectCompletionKeyOf(tx);
    if (completionKey !== undefined) {
      const committed = this.#sealChain.then(() =>
        this.#commitEffectCompletion(tx, completionKey)
      );
      this.#sealChain = committed.then(() => undefined, () => undefined);
      return committed;
    }
    const wave = this.#openWave();
    this.#waveByTx.set(tx, wave);
    const sealed = this.#sealChain.then(() => wave.seal(tx));
    this.#sealChain = sealed.then(() => undefined, () => undefined);
    // The scheduler runs autonomously off storage notifications: a seal
    // can arrive while the loop waits for input, and the wave it opened
    // must be committed — wake the loop.
    this.#feedArrived?.resolve();
    return sealed;
  }

  /**
   * TransactionSealDestination (stage G): take ownership of a sealed
   * transaction's post-commit effects — the loop hands external effects
   * to the outbox POST-wave-commit (serving-loop.md §3), never at seal,
   * where "ok" only means accepted into a wave. Effects of an abandoned
   * wave are discarded with it (park — the runtime dies, the
   * crash-equivalent path memo re-miss covers).
   */
  deferSealedEffects(
    tx: IExtendedStorageTransaction,
    effects: readonly PostCommitSideEffect[],
  ): boolean {
    const wave = this.#waveByTx.get(tx);
    if (wave === undefined || this.#outbox === undefined) return false;
    let pending = this.#pendingEffectsByWave.get(wave);
    if (pending === undefined) {
      pending = [];
      this.#pendingEffectsByWave.set(wave, pending);
    }
    pending.push({ tx, effects, context: waveRunContextOf(tx) });
    return true;
  }

  #openWave(): WaveAccumulator {
    if (this.#currentWave === undefined) {
      const { engine, space } = this.#options;
      const runtime = this.#runtime!;
      this.#currentWave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        // The wave-level identity fallback: the serving session's own.
        // Per-run demanded identities arrive via #stampRun's run
        // contexts (M1), which take precedence per contribution.
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (s) => runtime.storageManager.open(s).replica,
        lease: this.#lease,
      });
    }
    return this.#currentWave;
  }

  /** serving-loop.md §3d's stamping duty: the scheduler hands every run
   * here; per-run demanded identities (M1) plug into this seam when
   * Phase 2 maps demand to instances — Phase 1 runs carry the durable
   * action id and kind, and scoped addresses resolve via the wave
   * identity (cardinality 1). */
  #stampRun(tx: IExtendedStorageTransaction, info: ServerRunInfo): void {
    stampWaveRunContext(tx, {
      actionId: info.actionId,
      kind: info.kind,
      ...(info.eventId !== undefined ? { eventId: info.eventId } : {}),
    });
  }

  /**
   * The effect-COMPLETION commit (stage G, serving-loop.md §4's miss
   * rule): a served effect's writeback — result + `requestHash`, the
   * claim/pending markers, error-shaped results — commits as ONE
   * derived-class commit of its own. It never passes §3d's sealing (no
   * wave, no basis rows, no run stamp — the run is long over when the
   * response arrives); its identity annotations are sourced from the
   * OUTBOX CARRIAGE captured at the original run's seal (necessarily
   * stamped, so completion commits inherit stamped provenance
   * transitively — the 2026-08-05 clarification), falling back to the
   * wave-level identity where no entry is live (Phase 1's cardinality-1
   * posture, where the two are the same identity). The commit carries
   * `derivedThrough = W` (protocol.md §4: every derived commit carries
   * it; a completion advances nothing) and empty `consequenceOf`.
   * Result-cell dirtiness is injected IN-PROCESS by the sealNative
   * overlay promotion + the executor-commit report below; the
   * subscription's copy is an ordinary self-echo the loop skips.
   *
   * FP6's label carriage rides STRUCTURALLY: the writeback transaction
   * re-reads the request inputs (the hash guard), so the CFC ladder
   * derives the completion write's labels from the request basis
   * through the same per-transaction machinery as the OFF arm.
   *
   * A completion transaction that itself enqueues a post-commit effect
   * would flush INLINE at this seal (deferSealedEffects keys off the
   * wave a tx sealed into, and completions seal into none): no such
   * producer exists — the builtins' completions only write — and one
   * appearing should route through the outbox deliberately, not by
   * accident of this note going stale.
   */
  async #commitEffectCompletion(
    tx: IExtendedStorageTransaction,
    effectKey: string,
  ): Promise<Result<Unit, CommitError>> {
    const runtime = this.#runtime;
    const sink = this.#sink;
    const refuse = (message: string): Result<Unit, CommitError> => ({
      error: {
        name: "StorageTransactionAborted",
        message,
        reason: new Error("effect-completion-refused"),
      },
    });
    if (!this.#active || runtime === undefined || sink === undefined) {
      return refuse(
        "effect completion arrived while the space is parked; the " +
          "effect re-misses from its memo key on re-activation " +
          "(serving-loop.md §4, §6)",
      );
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      return refuse("storage transaction does not support sealing");
    }
    const carriage = this.#outbox?.carriageFor(effectKey);
    const identity = carriage?.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
    const sealedSpaces: Array<{
      space: MemorySpace;
      sealed: SealedNativeCommit;
      resolveVerdict: (verdict: SealedCommitVerdict) => void;
    }> = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: `space replica for ${space} does not support sealing`,
              reason: new Error("seal-unsupported"),
            },
          });
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        const sealed = replica.sealNative(native, source, promise);
        sealedSpaces.push({ space, sealed, resolveVerdict: resolve });
        return Promise.resolve({ ok: {} });
      },
    };
    const result = await inner.sealInto(collector);
    const withdrawAll = (message: string) => {
      for (const space of sealedSpaces) {
        space.resolveVerdict({ withdrawn: { message } });
      }
    };
    if (result.error) {
      withdrawAll(`effect completion seal failed: ${result.error.message}`);
      return result;
    }
    if (sealedSpaces.length === 0) {
      // Nothing to commit (all-no-op writeback) — done.
      return { ok: {} };
    }
    if (
      sealedSpaces.length > 1 ||
      sealedSpaces[0].space !== this.#options.space
    ) {
      withdrawAll(
        "effect completion may write only the serving space " +
          "(serving-loop.md §4; cross-space consequences leave only " +
          "as outbox appends — protocol.md §2b)",
      );
      return refuse(
        "effect completion wrote a foreign space; refused " +
          "(serving-loop.md §4)",
      );
    }
    const sealed = sealedSpaces[0];
    const operations = [...sealed.sealed.commit.operations];
    if (operations.some((operation) => operation.op === "sqlite")) {
      withdrawAll("effect completion carries folded sqlite ops; refused");
      return refuse(
        "effect completion transactions must not fold sqlite ops " +
          "(sqlite writes ride scheduler runs' wave batches)",
      );
    }
    const annotations: WaveWriteAnnotation[] = [];
    for (const [opIndex, operation] of operations.entries()) {
      // Unreachable after the refusal above; narrows the op type.
      if (operation.op === "sqlite") continue;
      const scoped = operation.scope !== undefined &&
        operation.scope !== "space";
      if (scoped || carriage?.acting !== undefined) {
        annotations.push({
          op: opIndex,
          ...(scoped
            ? { scopeKey: resolveScopeKey(operation.scope, identity) }
            : {}),
          ...(carriage?.acting !== undefined
            ? {
              actingUser: carriage.acting.user,
              ...(carriage.acting.session !== undefined
                ? { actingSession: carriage.acting.session }
                : {}),
            }
            : {}),
        });
      }
    }
    const outcome = await sink.commitWave({
      space: this.#options.space,
      home: true,
      // The completion's CAS basis is NOW: it writes only its own
      // result/claim docs, and a concurrent intrusion on them surfaces
      // as a conflict the writeback's retry loop re-decides against
      // fresh state (the hash guard re-reads inputs each attempt).
      basisSeq: Engine.serverSeq(this.#options.engine),
      rebasedHeads: [],
      operations,
      preconditions: [...sealed.sealed.commit.preconditions ?? []],
      annotations,
      consequenceOf: [],
      basisInstances: [],
      holder: this.#holder,
      derivedThrough: this.#watermark,
    });
    if (outcome.error) {
      withdrawAll(
        `effect completion commit rejected: ${outcome.error.message}`,
      );
      return refuse(
        `effect completion commit rejected: ${outcome.error.message}`,
      );
    }
    sealed.resolveVerdict({ committed: { seq: outcome.ok.seq } });
    this.#options.stats.derivedCommits += 1;
    // In-process dirtiness + push (the §4 injection): report like a
    // wave commit — subscribers get the derived rows, the feed carries
    // the record, and the loop skips its own echo by class + holder.
    const records = Engine.selectCommitsSince(this.#options.engine, {
      fromSeq: outcome.ok.seq - 1,
      limit: 1,
    });
    const record = records.find((entry) => entry.seq === outcome.ok.seq);
    if (record !== undefined) {
      this.#options.server.noteExecutorCommit({
        space: this.#options.space,
        seq: record.seq,
        class: "derived",
        holder: this.#holder,
        sessionId: record.sessionId,
        writes: record.writes as AdmittedCommitNotice["writes"],
      });
    }
    return { ok: {} };
  }

  #renew(): void {
    const lease = this.#lease;
    if (lease === undefined || !this.#active) return;
    if (!lease.renew()) {
      // Stop committing immediately (serving-loop.md §2's MUST): the
      // tenure ended inside renew(), so an in-flight wave aborts at its
      // commit step. Then re-acquire or park. The reacquire keeps this
      // loop serving ONLY when no wave sealed under the lapsed tenure:
      // a wave that does abort at commit had its sealed derivations
      // WITHDRAWN, and nothing re-arms their producers in place (no
      // revert consumer; inputs unchanged), so #waveCycle parks the
      // space on that abort rather than letting a continued loop mint a
      // watermark-only advance over work that never re-ran.
      this.#options.stats.lease.lost += 1;
      logger.warn("lease-lost", () => [
        `space ${this.#options.space}: lease renewal failed; ` +
        "in-flight wave aborts (serving-loop.md §2)",
      ]);
      if (!lease.acquire()) {
        void this.park("lease-lost");
      }
    }
  }

  // ---- the loop (serving-loop.md §3) ----

  async #loop(): Promise<void> {
    if (this.#loopRunning) return;
    this.#loopRunning = true;
    try {
      while (this.#active && !this.#parkRequested) {
        await this.#waveCycle();
        if (!this.#active || this.#parkRequested) break;
        if (!this.#hasWork()) {
          const idleParkMs = this.#options.policy?.idleParkMs ??
            DEFAULT_IDLE_PARK_MS;
          this.#idleSince ??= Date.now();
          if (
            Date.now() - this.#idleSince >= idleParkMs &&
            !this.#options.server.hasLiveSessionsForSpace(
              this.#options.space,
              // The loop's own loopback session is not client demand.
              { excludePrincipal: this.#options.serviceIdentity },
            ) &&
            this.#runtime?.scheduler.hasArmedGateWake() !== true
          ) {
            // Park per the activation policy (serving-loop.md §1): no
            // live client session, no undelivered events (none exist in
            // Phase 1), idle past IDLE_PARK_MS, and no armed gate wake
            // (runtime-mapping N9: a pending gate wake is "not idle").
            void this.park("idle");
            break;
          }
          await this.#waitForInput(idleParkMs);
        } else {
          this.#idleSince = undefined;
        }
      }
    } catch (error) {
      logger.error("loop-failed", "serving loop failed", error);
    } finally {
      this.#loopRunning = false;
    }
  }

  #hasWork(): boolean {
    return this.#feed.length > 0 ||
      (this.#currentWave?.contributionCount ?? 0) > 0;
  }

  async #waitForInput(maxMs: number): Promise<void> {
    if (this.#feed.length > 0) return;
    this.#feedArrived = Promise.withResolvers<void>();
    const timer = setTimeout(() => this.#feedArrived?.resolve(), maxMs);
    try {
      await this.#feedArrived.promise;
    } finally {
      clearTimeout(timer);
      this.#feedArrived = undefined;
    }
  }

  /** Drain the pending feed records into this cycle's input batch:
   * self-echoes (own derived commits, by class + holder) advance the
   * input head without any marking — their consequences are themselves
   * (serving-loop.md §3). Authored records count toward §7's
   * authoredSeen. Dirtiness itself travels the scheduler's existing
   * path: the loopback session's subscriptions deliver the commits'
   * doc changes, and storage notifications mark the graph dirty. */
  #drainFeed(): { batchHead: number } {
    for (const record of this.#feed) {
      if (record.seq <= this.#inputHead) continue;
      this.#inputHead = record.seq;
      const selfEcho = record.class === "derived" &&
        record.holder === this.#holder;
      if (selfEcho) continue;
      this.#coverageHead = record.seq;
      if (record.class === "authored") {
        this.#options.stats.authoredSeen += 1;
      }
    }
    this.#feed = [];
    return { batchHead: this.#coverageHead };
  }

  /** Load graph structure for the demanded values (serving-loop.md §1):
   * the server-side watch registry names what clients demand; each
   * demanded root's owning piece is ensured running (the sanctioned
   * auto-load prior art) so the scheduler can pull the demanded value
   * and its upstream. Failures are counted and logged — the ON-arm
   * bring-up posture: a value the server cannot serve stays
   * client-derived until Phase 2 hardens the load path. */
  async #loadDemandedStructure(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    const roots = this.#options.server.watchedRootsForSpace(
      this.#options.space,
      // The serving session's own watches are its graph's reads, not
      // client demand.
      { excludePrincipal: this.#options.serviceIdentity },
    );
    // Retire demand for roots no client watches anymore: the sink is
    // the demand, so cancelling it returns the value to pull-based
    // laziness (the materialized structure stays registered — structure
    // is not a start/stop policy, serving-loop.md §1).
    const currentKeys = new Set(
      roots.map((root) => `${root.scope ?? "space"}\0${root.id}`),
    );
    for (const [key, cancel] of this.#demandSinks) {
      if (currentKeys.has(key)) continue;
      try {
        cancel();
      } catch {
        // best-effort; the sink may already be torn down
      }
      this.#demandSinks.delete(key);
      this.#demandedRoots.delete(key);
    }
    for (const root of roots) {
      const key = `${root.scope ?? "space"}\0${root.id}`;
      if (this.#demandedRoots.has(key)) continue;
      this.#demandedRoots.add(key);
      try {
        await ensurePieceRunning(runtime, {
          space: this.#options.space,
          id: root.id as never,
          scope: root.scope ?? "space",
          path: [],
        });
      } catch (error) {
        this.#options.stats.structureLoadFailures += 1;
        logger.warn("structure-load-failed", () => [
          `demanded root ${root.id} did not load`,
          error,
        ]);
      }
      try {
        // The demand itself: a live reader per demanded root. Without
        // it the materialized graph's computeds stay
        // dirty-unmaterialized (pull-based laziness) and the wave never
        // has anything to derive for the subscriber. The read WALKS the
        // value (property access through the query-result proxies is
        // what pulls a computed's link), so every derivation reachable
        // from the demanded root is demanded — value-granular pull, at
        // the granularity the wire's watch selector actually names
        // (the whole doc).
        const cell = runtime.getCellFromLink({
          space: this.#options.space,
          id: root.id as never,
          scope: root.scope ?? "space",
          path: [],
        });
        const demandRead = (value: unknown) => {
          try {
            JSON.stringify(value);
          } catch {
            // a mid-pull proxy may throw; the re-fire after the pull
            // settles walks it again
          }
        };
        this.#demandSinks.set(key, cell.sink(demandRead));
      } catch (error) {
        logger.warn("demand-sink-failed", () => [
          `demand sink for ${root.id} failed`,
          error,
        ]);
      }
    }
  }

  /**
   * One wave (serving-loop.md §3): drain input, let the scheduler run
   * the affected graph to quiescence — or to the consequence-flush
   * deadline (the second exhaustion trigger, RULED 2026-08-04) — then
   * commit ONE derived transaction carrying the wave's writes, the
   * watermark doc write, and `derivedThrough`.
   */
  async #waveCycle(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined || !this.#active) return;
    const { batchHead } = this.#drainFeed();
    await this.#loadDemandedStructure();

    // Settle to quiescence under the flush deadline: idle() is the wave
    // boundary; synced() lets the loopback session's frames land so the
    // scheduler saw every input ≤ batchHead before we call the wave
    // quiescent (snapshot discipline: records arriving after the drain
    // belong to the NEXT wave).
    const deadlineMs = this.#options.policy?.flushDeadlineMs ??
      DEFAULT_FLUSH_DEADLINE_MS;
    const deadline = Date.now() + deadlineMs;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve("deadline"),
        Math.max(0, deadline - Date.now()),
      );
    });
    let exhausted = false;
    try {
      while (true) {
        // RACE the deadline (serving-loop.md §3's second exhaustion
        // trigger): "a wave still running at T_flush commits what is
        // sealed so far" — including a wave whose settle is stuck behind
        // work that will not quiesce (a hung load, an unquiescing
        // cascade). The deadline must be able to fire MID-await.
        const step = await Promise.race([
          (async () => {
            await runtime.idle();
            // Couple the settle to FRAME DELIVERY (W-soundness): the
            // feed learns of a commit synchronously at admission, but
            // the serving runtime's DIRTINESS arrives on the loopback
            // session's sync frames, which the server flushes on a
            // timer. Draining the co-hosted server's refresh queue here
            // guarantees every frame for commits ≤ batchHead has been
            // SENT before this pass can declare quiescence — without
            // it, a wave could advance W past an authored commit whose
            // demanded derivation never ran (the frame was still in
            // the flush queue).
            await this.#options.server.idle();
            // The INPUT barrier, not the durability barrier: sealed
            // commits settle at the wave commit BELOW, so the full
            // synced() would deadlock here (see
            // StorageManager.inputSynced).
            await runtime.storageManager.inputSynced?.();
            // One macrotask yield: loopback frames are delivered
            // synchronously on send, but their application schedules
            // work; the yield lets it register dirtiness so the
            // isIdle() probe below sees it. (An application parked
            // behind one of our own sealed commits stays the
            // documented inputSynced residual.)
            await new Promise((resolve) => setTimeout(resolve, 0));
            return "settled" as const;
          })(),
          deadlinePromise,
        ]);
        if (step === "deadline") {
          exhausted = true;
          break;
        }
        if (runtime.scheduler.isIdle()) break;
        if (Date.now() >= deadline) {
          exhausted = true;
          break;
        }
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }

    const wave = this.#currentWave;
    const haveContributions = (wave?.contributionCount ?? 0) > 0;
    // W jumps to the top of the input batch at TRUE quiescence
    // (serving-loop.md §3): everything at or below batchHead has its
    // consequences committed and its demanded derivations current —
    // that is what the settle above established. An exhausted flush
    // carries no watermark movement. The advance is input-driven (the
    // batch head only moves when commits arrive), so a quiet space
    // commits nothing.
    const advanceTo = exhausted ? this.#watermark : batchHead;
    const shouldAdvance = !exhausted && advanceTo > this.#watermark;

    if (!haveContributions && !shouldAdvance) {
      // Nothing sealed and no watermark movement: no commit (the
      // zero-delta case — light cycles cost nothing). An EXHAUSTED
      // empty cycle is still counted: a wedged never-quiescing settle
      // is exactly what §7's wavesBudgetExhausted exists to surface.
      if (exhausted) {
        this.#options.stats.wavesBudgetExhausted += 1;
      }
      return;
    }

    // The loop's own bookkeeping write (the sanctioned internal stamp
    // kind): the watermark doc advances INSIDE the same wave commit —
    // never its own commit (protocol.md §4). An exhausted wave carries
    // no watermark movement (`derivedThrough` stays at the current W;
    // serving-loop.md §3). Written as a key-path SET (a patch against an
    // existing doc) so the bookkeeping conflict class's REBASE arm is
    // live: a disjoint concurrent patch to the watermark doc commutes,
    // while a whole-doc authored intrusion (forgery) still conflicts
    // semantically and drops the DOC write whole. Stated truthfully:
    // that drop is decided inside commitWave, AFTER `advanceSealed`
    // below already fed `derivedThrough` and armed the in-memory
    // advance — which keys off the WAVE commit succeeding
    // (`outcome.seq`), not off the doc write surviving — so the commit
    // metadata and this loop's `#watermark` still advance while the doc
    // lags, and on a quiet space no re-advance follows (the advance is
    // input-driven; the next one comes with the next input batch).
    // Accepted, not a gap to fix here: watermark forgery is an authored
    // intrusion inside protocol.md §1's threat model, and the failure
    // is conservative for clients — waitForSettled reads the DOC, so a
    // dropped doc write leaves them unsettled (never settled early),
    // until the next input-driven advance re-lands it.
    let advanceSealed = false;
    if (shouldAdvance) {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: WATERMARK_ACTION_ID,
        kind: "bookkeeping",
      });
      watermarkCell(runtime, this.#options.space).withTx(tx).key("seq").set(
        advanceTo,
      );
      const committed = await tx.commit();
      if (committed.error) {
        // The advance did not enter the wave: W must not move either —
        // the doc and the metadata advance together or not at all
        // (protocol.md §4's same-transaction invariant).
        logger.warn("watermark-seal-failed", () => [
          "watermark bookkeeping write failed to seal; W held",
          committed.error,
        ]);
      } else {
        advanceSealed = true;
      }
    }

    const closing = this.#currentWave;
    if (closing === undefined) return;
    this.#currentWave = undefined;
    await this.#sealChain;

    const derivedThrough = !exhausted && advanceSealed
      ? advanceTo
      : this.#watermark;
    const outcome = await closing.commitWave(this.#sink!, { derivedThrough });
    await closing.settled();
    // The effect handoff (stage G, serving-loop.md §3): external effects
    // go to the outbox POST-commit. Taken off the map here either way;
    // the lease-lost branch below parks, so its batches are simply
    // dropped — the runtime dies with the wave (crash-equivalent, memo
    // re-miss covers the effect on re-activation).
    const pendingEffects = this.#pendingEffectsByWave.get(closing);
    this.#pendingEffectsByWave.delete(closing);

    const stats = this.#options.stats;
    stats.waves += 1;
    if (exhausted) stats.wavesBudgetExhausted += 1;
    stats.supersededWrites += outcome.supersededWrites;
    // Stage G, post-commit: hand the wave's sealed effects to the
    // outbox BEFORE anything below can throw (a failed commit-record
    // fetch must not leak effects with the runtime still alive) — but
    // never on the lease-lost arm, whose park below discards them with
    // the dying runtime (the crash-equivalent path memo re-miss
    // covers). Fired for every other outcome — a withdrawn
    // contribution's action re-runs and re-enqueues (deduped in
    // flight), and completion writes are hash-guarded against current
    // inputs, so a superseded request's writeback is inert
    // (at-least-once, serving-loop.md §4).
    if (
      outcome.aborted !== "lease-lost" &&
      pendingEffects !== undefined && pendingEffects.length > 0
    ) {
      this.#outbox?.admitSealedEffects(pendingEffects);
    }
    if (outcome.aborted === "lease-lost") {
      // PARK, never continue (W-soundness): the abort WITHDREW the
      // wave's sealed derivations, nothing re-arms their producers in
      // place (no revert consumer; the inputs did not change), and
      // #coverageHead has already claimed the input batch — a continued
      // loop (the renew-blip reacquire path, where lease.acquire()
      // succeeded and this runtime kept running) would mint a
      // watermark-only advance next cycle over demanded derivations
      // that never re-ran, making waitForSettled lie until the next
      // input change. Re-activation's fresh-runtime recompute-on-demand
      // is the ONLY post-abort recovery arm (serving-loop.md §6 step 2:
      // a demanded pull recomputes regardless).
      logger.warn("wave-aborted", () => [
        "wave aborted: lease lost mid-wave; parking " +
        "(serving-loop.md §2)",
      ]);
      await this.park("lease-lost-abort");
      return;
    }
    if (outcome.seq !== undefined) {
      stats.derivedCommits += 1;
      if (!exhausted && advanceSealed) {
        this.#watermark = advanceTo;
      }
      // The wave commit entered the store on the co-hosted engine plane,
      // not through any session: report it so push fires (M4 — derived
      // commits reach subscribers) and the feed carries it (the loop
      // skips its own echo by class + holder).
      const records = Engine.selectCommitsSince(this.#options.engine, {
        fromSeq: outcome.seq - 1,
        limit: 1,
      });
      const record = records.find((entry) => entry.seq === outcome.seq);
      if (record !== undefined) {
        this.#options.server.noteExecutorCommit({
          space: this.#options.space,
          seq: record.seq,
          class: "derived",
          holder: this.#holder,
          sessionId: record.sessionId,
          writes: record.writes as AdmittedCommitNotice["writes"],
        });
      }
    }

    // Drain the durable append rows (FP1): after a wave that landed
    // appends, and after any earlier drain left rows behind (a
    // transport-failed delivery on a long-lived active space must not
    // wait for the next appends-carrying wave or a re-activation).
    // Co-hosted delivery is an engine commit, not a network await.
    if (
      (closing.hasOutboundAppends && outcome.seq !== undefined) ||
      this.#outboxDrainOwed
    ) {
      try {
        const drained = await this.#outbox?.deliverPendingAppends();
        this.#outboxDrainOwed = (drained?.remaining ?? 0) > 0;
      } catch (error) {
        this.#outboxDrainOwed = true;
        logger.warn("append-drain-failed", () => [
          "post-wave outbox drain failed; rows kept for re-send",
          error,
        ]);
      }
    }
  }

  /** Park (serving-loop.md §1): release the lease, dispose the runtime.
   * A park racing an incoming commit self-heals — the admission hook
   * re-fires on the next admission and the host re-activates. */
  async park(reason: string): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    this.#parkRequested = true;
    this.#options.stats.activeSpaces = Math.max(
      0,
      this.#options.stats.activeSpaces - 1,
    );
    if (this.#renewTimer !== undefined) {
      clearInterval(this.#renewTimer);
      this.#renewTimer = undefined;
    }
    this.#feedArrived?.resolve();
    for (const cancel of this.#demandSinks.values()) {
      try {
        cancel();
      } catch {
        // sink cancellation is best-effort during teardown
      }
    }
    this.#demandSinks.clear();
    this.#demandedRoots.clear();
    const wave = this.#currentWave;
    this.#currentWave = undefined;
    await this.#sealChain;
    wave?.abandon(`parked: ${reason}`);
    // Stage G: an abandoned wave's deferred effects are DISCARDED with
    // it — the runtime below is disposed, so this is the
    // crash-equivalent path §4/§6 already cover (the effect re-misses
    // from memo keys on re-activation). In-flight effect work is not
    // awaited (park never awaits the network); its writebacks fail
    // against the disposed runtime and are caught by the builtins.
    this.#pendingEffectsByWave.clear();
    this.#outbox = undefined;
    try {
      if (this.#runtime !== undefined) {
        this.#runtime.asyncWorkObserver = undefined;
        this.#runtime.effectMemoObserver = undefined;
      }
      this.#runtime?.clearSealDestination();
      await this.#disposeRuntime?.();
    } catch (error) {
      logger.warn("park-dispose-failed", () => [
        "runtime dispose during park failed",
        error,
      ]);
    }
    this.#runtime = undefined;
    this.#disposeRuntime = undefined;
    this.#lease?.release();
    this.#lease = undefined;
    logger.info?.("parked", () => [
      `space ${this.#options.space} parked (${reason})`,
    ]);
    this.#options.onParked?.(reason);
    this.#parked.resolve();
  }
}
