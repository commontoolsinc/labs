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
import {
  deleteExecutionOutboxRow,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
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
  readonly #localSeqRef: { value: number };
  /** In-flight effect work per effect id — §4's in-flight dedupe: a
   * second admit of a live id attaches to (is served by) the first. */
  readonly #inflight = new Map<string, Promise<void>>();
  /** Run-context carriage per in-flight effect id (§4's miss rule),
   * consumed by the completion committer; retired when the effect's
   * work settles (every completion write of an effect happens inside
   * its tracked work, so nothing consults a retired entry — a late
   * straggler falls back to the wave-level identity, which is the same
   * identity in Phase 1). */
  readonly #carriage = new Map<string, WaveRunContext>();
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
        this.#inflight.set(key, work);
        this.#stats.memo.inflight = this.#inflight.size;
        void work.finally(() => {
          this.#inflight.delete(key);
          this.#carriage.delete(key);
          this.#stats.memo.inflight = this.#inflight.size;
        });
      }
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

  /** Every in-flight effect settled — a test/diagnostic barrier; the
   * serving loop never awaits it (the loop never awaits the network). */
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
   * entries to annotate yet. Transport-class failures keep the row for
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
          eventId: row.eventId,
          payload: row.payload,
          ...(row.actingPrincipal === undefined
            ? {}
            : { actingPrincipal: row.actingPrincipal }),
          ...(row.actingSession === undefined
            ? {}
            : { actingSession: row.actingSession }),
          capabilityRef: row.capabilityRef,
          sessionId: this.#sessionId,
          localSeq: ++this.#localSeqRef.value,
        });
        // Delivery-ack: the target processed the entry (admitted or
        // horizon-deduped) — retire the row (FP1's queue that empties).
        deleteExecutionOutboxRow(this.#engine, row.rowId);
      } catch (error) {
        if (error instanceof ProtocolError) {
          // LT4: a deterministic admission rejection does not retry.
          this.#stats.outbox.failed += 1;
          try {
            deleteExecutionOutboxRow(this.#engine, row.rowId);
          } catch (deleteError) {
            // A failed retirement must not abort the drain; the row
            // re-sends and hits the same deterministic rejection.
            remaining += 1;
            logger.warn("append-retire-failed", () => [
              `retiring rejected append ${row.eventId} failed; row kept`,
              deleteError,
            ]);
          }
          logger.warn("append-rejected", () => [
            `outbox append ${row.eventId} → ${row.targetSpace} rejected ` +
            "deterministically; not retried (LT4). The source-side " +
            "failure notice lands with Phase 3's events.md §5 machinery.",
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
}
