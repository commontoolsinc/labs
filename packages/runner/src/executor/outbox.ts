// The SpaceServer's outbox (server-execution v2 stage G, serving-loop.md
// §4–§5): both halves of the effect channel.
//
// - The EFFECT half is PROCESS-LOCAL by design (§5; the FP1 ruling keeps
//   it that way): a queue of sealed post-commit effects — the network
//   work of `fetch*`, `generate*`, `sqlite*` — handed over by the wave
//   cycle AFTER the wave commit (never at seal: §3's "hand external
//   effects to the outbox (post-commit)"), deduped in flight per effect
//   id (`${kind}:${inputHash}` — the memo key basis; §4's "one
//   outstanding effect per key per space; a second miss attaches").
//   Crash-soundness needs no durability here: a crash re-misses the
//   effect from memo keys (§4, §6 step 3 — RULED, at-least-once
//   accepted). Per-entry run-context CARRIAGE (§4's miss rule: the
//   result-cell identity resolution + the acting identity + — carried
//   structurally — the label basis) is captured from the sealing
//   transaction's stamped context and consumed by the completion
//   committer (space-server.ts).
// - The DURABLE half (FP1, RULED 2026-08-03) is the engine-table rows
//   of cross-space event appends — written inside the emitting wave's
//   own transaction by the sink; this module DELIVERS them (an authored
//   delegated commit at the target — protocol.md §2, §2b; LT5's service
//   envelope) and deletes each row on delivery-ack. Activation calls
//   `deliverPendingAppends` to re-send undelivered rows (§6 step 5);
//   duplicates dedupe at the target's eventId horizon.
//
// FORBIDDEN and respected: no effect retry timers (failures commit
// error-shaped results; retries are input-driven — §4), no "pending
// effects" table (the effect half never touches the store), no delivery
// of a withdrawn contribution's appends (the wave folds survivors only).

import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { Engine } from "@commonfabric/memory/v2/engine";
import * as EngineModule from "@commonfabric/memory/v2/engine";
import {
  deleteExecutionOutboxRow,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import type { PendingOutboxRow } from "@commonfabric/memory/v2/execution-outbox";
import { ProtocolError } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";
import type { PostCommitSideEffect } from "../cfc/types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { WaveRunContext } from "./wave.ts";
import type { ServingLoopStats } from "./stats.ts";

const logger = getLogger("space-outbox", { enabled: true, level: "warn" });

/** One sealed effect awaiting its wave's commit: the transaction it
 * sealed with (the flush contract passes it back), the effects it
 * enqueued, and the run context captured at seal — §4's identity
 * carriage, the completion commit's only annotation source. */
export interface SealedEffectBatch {
  tx: IExtendedStorageTransaction;
  effects: readonly PostCommitSideEffect[];
  context: WaveRunContext | undefined;
}

export class SpaceOutbox {
  readonly #stats: ServingLoopStats;
  readonly #server: MemoryServer;
  readonly #engine: Engine;
  readonly #sessionId: string;
  readonly #space?: string;
  readonly #localSeqRef: { value: number };
  /** In-flight effect entries per effect id — §4's in-flight dedupe: a
   * second admit of a live id attaches to (is served by) the first. The
   * stored promise is the entry's RETIREMENT (work settled AND every
   * completion commit readable — see #retireBarriers), which is what
   * `settle()` awaits. */
  readonly #inflight = new Map<string, Promise<void>>();
  /** Run-context carriage per in-flight effect id (§4's miss rule),
   * consumed by the completion committer; retired with the entry
   * (every completion write of an effect happens inside its tracked
   * work, so nothing consults a retired entry — a late straggler falls
   * back to the wave-level identity, which is the same identity in
   * Phase 1). */
  readonly #carriage = new Map<string, WaveRunContext>();
  /** Read-consistency barriers per in-flight effect id (serving-loop.md
   * §4; the stage-G review's B-1): each completion commit of a served
   * effect registers a promise that resolves when its writes are
   * READABLE by the serving runtime (the replica applied the accept —
   * `ISpaceReplica.whenApplied`). Retirement awaits them, so the
   * in-flight entry keeps deduping stale re-admits across the
   * absorption window. Without this, the captured double-fire fires: a
   * completion commits engine-side and retires the key, a later wave's
   * stale-snapshot re-run re-admits it, and the re-admitted claim's
   * reads — not yet showing the completion — pass the hash guard and
   * egress a second time. */
  readonly #retireBarriers = new Map<string, Array<Promise<unknown>>>();
  /** Sync-span capture target for the runtime's async-work observer:
   * while an effect's flush runs its SYNCHRONOUS prefix, work the
   * builtin registers via trackAsyncWork lands here — that work IS the
   * effect (fetch/llm callbacks return synchronously after starting
   * it), and outbox.completed counts only when it settles. */
  #capturing: Array<Promise<unknown>> | undefined;

  constructor(options: {
    stats: ServingLoopStats;
    server: MemoryServer;
    /** The HOME space's engine — where the durable append rows live. */
    engine: Engine;
    /** The HOME space did — the OW14 failure notice commits into it as
     * a derived-class commit, whose lease admission needs the space. */
    space?: string;
    /** The delivering service session (LT5's envelope) — the DR1
     * holder, same as the wave sink's. */
    sessionId: string;
    /** The host's process-lifetime localSeq counter, shared with the
     * wave sink (the replay-keying discipline — engine-wave-sink.ts). */
    localSeqRef: { value: number };
  }) {
    this.#stats = options.stats;
    this.#server = options.server;
    this.#engine = options.engine;
    this.#space = options.space;
    this.#sessionId = options.sessionId;
    this.#localSeqRef = options.localSeqRef;
  }

  /** The runtime's async-work observer hook (installed by the
   * SpaceServer on the serving runtime): captures work started inside
   * an effect flush's synchronous prefix. */
  observeAsyncWork(work: Promise<unknown>): void {
    this.#capturing?.push(work);
  }

  /** The §4 identity carriage for an in-flight effect, captured at the
   * original run's seal. */
  carriageFor(effectKey: string): WaveRunContext | undefined {
    return this.#carriage.get(effectKey);
  }

  /**
   * Defer the effect's in-flight retirement behind `barrier` — the B-1
   * read-consistency gate: the completion committer registers, per
   * completion commit, a promise resolving when that commit's writes
   * are READABLE by the serving runtime (the replica applied the
   * accept). The effect's entry retires only after its work settled
   * AND every registered barrier resolved, so a stale re-admit of the
   * key keeps deduping across the absorption window instead of
   * re-claiming against unabsorbed state (the captured double-egress).
   * A registration for a key not in flight is a no-op: a straggler
   * completion of an already-retired key has nothing to hold.
   */
  deferRetirement(effectKey: string, barrier: Promise<unknown>): void {
    if (!this.#inflight.has(effectKey)) return;
    let barriers = this.#retireBarriers.get(effectKey);
    if (barriers === undefined) {
      barriers = [];
      this.#retireBarriers.set(effectKey, barriers);
    }
    barriers.push(barrier);
  }

  get inflightCount(): number {
    return this.#inflight.size;
  }

  /**
   * Admit one wave's sealed effect batches — called by the wave cycle
   * AFTER the wave commit step returned (post-commit; §3). Deduped per
   * effect id against in-flight work (§4). The effects fire regardless
   * of their contribution's per-doc disposition: a withdrawn
   * contribution's action re-runs and re-enqueues (deduped here), and
   * every completion write is hash-guarded against CURRENT inputs, so
   * a superseded request's writeback is inert — at-least-once, the
   * ruled posture (§4, §6 step 3). Batches of an ABANDONED wave are
   * never admitted (the space parks and its runtime dies — the
   * crash-equivalent path, covered by memo re-miss).
   */
  admitSealedEffects(batches: readonly SealedEffectBatch[]): void {
    for (const batch of batches) {
      for (const effect of batch.effects) {
        const key = effect.idempotencyKey ?? effect.id;
        if (this.#inflight.has(key)) {
          // §4's in-flight dedupe: the second miss attaches — the live
          // effect's completion serves both requesters (same key ⇒ same
          // result cells).
          continue;
        }
        this.#stats.outbox.queued += 1;
        this.#stats.memo.misses += 1;
        if (batch.context !== undefined) {
          this.#carriage.set(key, batch.context);
        }
        const work = this.#runEffect(key, effect, batch.tx);
        const retirement = work.catch(() => undefined)
          .then(() => this.#awaitRetireBarriers(key))
          .finally(() => {
            this.#retireBarriers.delete(key);
            this.#inflight.delete(key);
            this.#carriage.delete(key);
            this.#stats.memo.inflight = this.#inflight.size;
          });
        this.#inflight.set(key, retirement);
        this.#stats.memo.inflight = this.#inflight.size;
      }
    }
  }

  /** Await every registered read-consistency barrier for `key`,
   * re-checking after each pass: a completion committing DURING the
   * await (a late writeback of attached work) registers into a fresh
   * list, and the entry must not retire ahead of it. Never rejects —
   * barriers resolve on apply, reset, and close (the replica side), and
   * a rejected barrier must not wedge retirement. A registration
   * landing in the ~1-microtask window between the final empty check
   * here and the caller's `.finally` cleanup is deleted unawaited —
   * the documented at-least-once straggler posture (unreachable
   * today: every production writeback runs inside tracked work). */
  async #awaitRetireBarriers(key: string): Promise<void> {
    while (true) {
      const barriers = this.#retireBarriers.get(key);
      if (barriers === undefined || barriers.length === 0) return;
      this.#retireBarriers.delete(key);
      await Promise.allSettled(barriers);
    }
  }

  async #runEffect(
    key: string,
    effect: PostCommitSideEffect,
    tx: IExtendedStorageTransaction,
  ): Promise<void> {
    // Capture the builtin's tracked work during the SYNCHRONOUS prefix
    // of the flush only: fetch/llm callbacks start their network work
    // and register it via trackAsyncWork before returning; sqlite's
    // async flush IS its work. Restricting capture to the synchronous
    // prefix keeps concurrent scheduler runs' tracked work out.
    const captured: Array<Promise<unknown>> = [];
    this.#capturing = captured;
    let flushResult: Promise<void> | void;
    try {
      flushResult = effect.flush(tx) as Promise<void> | void;
    } catch (error) {
      this.#capturing = undefined;
      this.#stats.outbox.failed += 1;
      logger.warn("effect-flush-failed", () => [
        `effect ${key} flush threw`,
        error,
      ]);
      return;
    }
    this.#capturing = undefined;
    try {
      await flushResult;
      const settled = await Promise.allSettled(captured);
      const rejected = settled.find((entry) => entry.status === "rejected");
      if (rejected !== undefined) {
        // Infrastructure failure of the effect's own work — effect-level
        // failures commit error-shaped RESULTS instead and never reject
        // (§4's failure rule), so a rejection here is the runtime path
        // breaking, not the request failing.
        this.#stats.outbox.failed += 1;
        logger.warn("effect-work-failed", () => [
          `effect ${key} async work rejected`,
          (rejected as PromiseRejectedResult).reason,
        ]);
        return;
      }
      this.#stats.outbox.completed += 1;
    } catch (error) {
      this.#stats.outbox.failed += 1;
      logger.warn("effect-flush-failed", () => [
        `effect ${key} flush rejected`,
        error,
      ]);
    }
  }

  /** Every in-flight effect RETIRED — work settled and every completion
   * readable (the B-1 barrier). A test/diagnostic barrier; the serving
   * loop never awaits it (the loop never awaits the network). */
  async settle(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight.values()]);
    }
  }

  /**
   * Deliver every pending durable append row (FP1; serving-loop.md §6
   * step 5's re-send on activation, and the post-wave drain): admit at
   * the target through the delegated-append path (protocol.md §2, §2b —
   * `firedAt` from the carried actor, envelope the service session),
   * then DELETE the row — admit-before-delete, so a crash between the
   * two re-sends and the target's eventId horizon dedupes (the spec
   * model's C2/FP1 closure: no schedule loses an append). Rows are
   * delivered in insertion order (FIFO per source wave → target
   * stream). A DETERMINISTIC admission rejection (LT4) is not retried:
   * the row is deleted and counted failed — its source-side failure
   * notice is Phase 3's events.md §5 machinery, which has no stream
   * entries to annotate yet. When that machinery lands, the notice
   * must be written BEFORE the row delete (verification-coverage
   * OW14 — today the delete discards eventId/target/reason beyond
   * the warn log). Transport-class failures keep the row for
   * the next drain (at-least-once, no timers).
   */
  async deliverPendingAppends(): Promise<{ remaining: number }> {
    const rows = selectPendingExecutionOutboxRows(this.#engine, {
      branch: "",
    });
    let remaining = 0;
    for (const row of rows) {
      try {
        await this.#server.commitDelegatedAppend({
          targetSpace: row.targetSpace,
          targetStream: row.targetStream,
          ...(row.targetStreamLink === undefined
            ? {}
            : { targetStreamLink: row.targetStreamLink }),
          eventId: row.eventId,
          payload: row.payload,
          ...(row.actingPrincipal === undefined
            ? {}
            : { actingPrincipal: row.actingPrincipal }),
          ...(row.actingSession === undefined
            ? {}
            : { actingSession: row.actingSession }),
          // The OW15 declaration passes through to the target's floor
          // carve-out (protocol.md §2): an ABSENT acting principal
          // admits iff declared, stamping firedAt = {session:"server"}.
          ...(row.sessionlessSpaceScope === true
            ? { sessionlessSpaceScope: true }
            : {}),
          capabilityRef: row.capabilityRef,
          sessionId: this.#sessionId,
          localSeq: ++this.#localSeqRef.value,
        });
        // Delivery-ack: the target processed the entry (admitted or
        // horizon-deduped) — retire the row (FP1's queue that empties).
        deleteExecutionOutboxRow(this.#engine, row.rowId);
      } catch (error) {
        if (error instanceof ProtocolError) {
          // LT4: a deterministic admission rejection does not retry. The
          // source-side failure notice writes BEFORE the row retires
          // (OW14's write-then-delete order): a crash between the two
          // re-sends the row, hits the same deterministic rejection,
          // and RE-NOTICES — deduped by the refused append's eventId —
          // so the notice is never lost. A row with no source event (a
          // derivation-emitted append) falls back to the warn log.
          this.#stats.outbox.failed += 1;
          const noticed = this.#writeDeliveryFailureNotice(
            row,
            error instanceof Error ? error.message : String(error),
          );
          if (!noticed) {
            // The notice could not be written durably: KEEP the row so
            // the next drain re-attempts both (write-then-delete —
            // deleting now would lose the notice forever).
            remaining += 1;
            logger.warn("append-notice-failed", () => [
              `failure notice for rejected append ${row.eventId} could ` +
              "not be written; row kept so the next drain re-notices",
              error,
            ]);
            continue;
          }
          try {
            deleteExecutionOutboxRow(this.#engine, row.rowId);
          } catch (deleteError) {
            // A failed retirement must not abort the drain; the row
            // re-sends, hits the same deterministic rejection, and the
            // notice dedupes.
            remaining += 1;
            logger.warn("append-retire-failed", () => [
              `retiring rejected append ${row.eventId} failed; row kept`,
              deleteError,
            ]);
          }
          logger.warn("append-rejected", () => [
            `outbox append ${row.eventId} → ${row.targetSpace} rejected ` +
            "deterministically; not retried (LT4); the source-side " +
            "failure notice is on the source event's entry (OW14).",
            error,
          ]);
          continue;
        }
        // Transport-class failure: keep the row; the next drain (or the
        // next activation's §6 step 5) re-sends. No timers.
        remaining += 1;
        logger.warn("append-delivery-failed", () => [
          `outbox append ${row.eventId} → ${row.targetSpace} failed; ` +
          "row kept for re-send",
          error,
        ]);
      }
    }
    return { remaining };
  }

  /**
   * OW14 (protocol.md §2b's LT4 ruling): write the deterministic
   * delivery refusal's failure notice onto the SOURCE event's stream
   * entry — "a failure notice on the source event's stream entry,
   * written by the source SpaceServer" — per events.md §5's
   * error-is-the-consequence shape. Deduped by the refused append's
   * eventId; a small derived-class engine commit of the loop's own
   * (the completion-commit precedent: post-wave, never through §3d's
   * sealing). Returns whether the notice is durably present (already
   * present counts).
   */
  #writeDeliveryFailureNotice(
    row: PendingOutboxRow,
    reason: string,
  ): boolean {
    if (row.sourceEvent === undefined) {
      logger.warn("append-rejected-unsourced", () => [
        `rejected append ${row.eventId} carries no source event; the ` +
        "failure notice has no entry to land on (a derivation-emitted " +
        "append) — log-only",
      ]);
      return true;
    }
    try {
      const doc = EngineModule.read(this.#engine, {
        id: row.sourceEvent.sidecarId,
      });
      const entries =
        ((doc?.value ?? {}) as { entries?: Array<StreamEventEntryShape> })
          .entries ?? [];
      const index = entries.findIndex((entry) =>
        entry?.eventId === row.sourceEvent!.eventId
      );
      if (index < 0) {
        // The source entry compacted away (events.md §4's allowance):
        // the notice never outlives the entry it annotates.
        return true;
      }
      const existing = entries[index]?.deliveryFailures ?? [];
      if (existing.some((failure) => failure.eventId === row.eventId)) {
        return true;
      }
      if (this.#space === undefined) {
        logger.warn("append-notice-unspaced", () => [
          `failure notice for ${row.eventId} needs the home space for ` +
          "derived admission; outbox constructed without one — log-only",
        ]);
        return true;
      }
      EngineModule.applyCommit(this.#engine, {
        sessionId: this.#sessionId,
        space: this.#space,
        commitClass: "derived",
        holder: this.#sessionId,
        commit: {
          localSeq: ++this.#localSeqRef.value,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: row.sourceEvent.sidecarId as never,
            patches: [{
              op: "replace",
              path: `/value/entries/${index}/deliveryFailures`,
              value: [
                ...existing,
                {
                  eventId: row.eventId,
                  targetSpace: row.targetSpace,
                  reason,
                },
              ] as never,
            }],
          }],
        },
      });
      return true;
    } catch (error) {
      logger.warn("append-notice-write-failed", () => [
        `failure notice write for ${row.eventId} threw`,
        error,
      ]);
      return false;
    }
  }
}

type StreamEventEntryShape = {
  eventId?: string;
  deliveryFailures?: Array<{
    eventId: string;
    targetSpace: string;
    reason: string;
  }>;
} | null;
