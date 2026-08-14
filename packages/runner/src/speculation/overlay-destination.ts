// The client speculation overlay (server-execution v2 Phase 2;
// speculation.md is normative). Under EXPERIMENTAL_SERVER_EXECUTION a
// NON-serving runtime — every client, and any server-side utility
// runtime that is not the space's SpaceServer — loses its
// derivation-commit path BY CONSTRUCTION: the runtime's default seal
// destination is this overlay, so a stamped derivation-kind run's
// writes are REDIRECTED into the replica's optimistic pending layer
// (`sealNative` with a speculation verdict) instead of a storage
// commit. There is no client code path from a derivation run to the
// wire, and none that could construct a `derived`-class commit
// (protocol.md §1's FORBIDDEN clause holds structurally).
//
// What stays on today's commit path, exactly (the plan's Phase 3
// interim postures row — F10's handler interim ENDED with events-down,
// events.md §7):
// - bookkeeping runs (the client-side pattern swap's pointer write is
//   an ordinary authored input);
// - UNSTAMPED transactions — UI-binding writes, imperative edits, and
//   the event-append commit itself (the fire's one authored act,
//   events.md §1) are state authorship under existing ACL + CAS
//   (README §3.6), and they never pass through the scheduler's
//   stamping choke points.
//
// Event-HANDLER runs divert here exactly like derivation runs since
// Phase 3 (D-v2-1): the handler's writes are the speculative ECHO
// (speculation.md §2), tagged with the fired event's id so the echo
// retires when the authoritative consequences (or the dropped-event
// notice) arrive (speculation.md §4 step 2; the watermark sweep is the
// backstop). The client handler-write COMMIT path is deleted — there
// is no code path from a handler run to the wire (events.md §7).
//
// The overlay is process-memory only (speculation.md §1): entries are
// never serialized, never synced, never committed, and they stay OUT
// of the client's `synced()` durability barrier. Reads see them
// through the replica's ordinary pending materialization, so rendering
// and downstream speculation read one code path. Reconciliation
// (speculation.md §4) is watermark-driven: when the space's replicated
// watermark doc covers an entry's read basis — and no unpromoted
// authored origin still underlies it (the "acked AND W ≥ seq" rule,
// evaluated on replica state) — the entry retires via a
// SUCCESS-shaped withdrawal (`superseded`), the authoritative value
// replaces the echo in the same render path, and nothing cascades.
//
// Post-commit effects of a speculative run follow the egress rule
// (README §1): "speculate on anything you can throw away; never on
// anything you can't take back." Reversible, client-enacted effects —
// exactly the `navigateTo` kind today (optimistic enactment,
// speculation.md §2) — still flush; every other kind (external-sink
// egress, sqlite issue) is OWNED AND DROPPED, so an effectful builtin
// reached by speculation renders its pending state and reads through
// to the last committed result while only the server performs egress
// (README §3.5).

import { getLogger } from "@commonfabric/utils/logger";
import {
  type CellScope,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import type { Runtime, ServerRunInfo } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  TransactionSealDestination,
  Unit,
  URI,
} from "../storage/interface.ts";
import type { CommitError } from "../storage/interface.ts";
import type { PostCommitSideEffect } from "../cfc/types.ts";

const logger = getLogger("speculation-overlay", {
  enabled: true,
  level: "warn",
});

/**
 * The client-side run stamp (the speculation twin of the wave run
 * context). Kept in its OWN WeakMap so `waveRunContextOf` remains a
 * server-only signal: builtins and tests that ask "am I a served run?"
 * must not start seeing client speculation runs as served.
 */
const speculationRunContexts = new WeakMap<object, ServerRunInfo>();

export const stampSpeculationRunContext = (
  tx: IExtendedStorageTransaction,
  info: ServerRunInfo,
): void => {
  speculationRunContexts.set(tx, info);
};

export const speculationRunContextOf = (
  tx: IExtendedStorageTransaction,
): ServerRunInfo | undefined => speculationRunContexts.get(tx);

/** The one effect kind a speculative run may still enact: reversible,
 * client-enacted navigation (speculation.md §2's optimistic navigate;
 * protocol.md §5 owns the eventual nonce channel). Every other kind is
 * dropped under speculation — a NEW reversible kind must be added here
 * deliberately, with its spec edit (protocol.md §5's FORBIDDEN list),
 * never by default. */
const SPECULATION_ENACTABLE_EFFECT_KINDS = new Set(["navigateTo"]);

/** A terminal event-intent outcome the client is SIGNALED about
 * (events.md §5): dropped (the conflicting-discharge notice), errored
 * (the handler threw server-side — the error is the consequence), or
 * refused (deterministic admission refusal at discharge). */
export type EventIntentOutcome = {
  space: MemorySpace;
  eventId: string;
  kind: "dropped" | "errored" | "refused";
  reason: string;
};

/** A fired intent's terminal consequence, as awaited by the send
 * path's durable-ack coupling (verdict blocker, 2026-08-12):
 * `consequenced` is the SUCCESS arm (the authoritative server handling
 * committed — signaled by the consequence mark, or by watermark-sweep
 * coverage, the same two signals that retire the echo); the other
 * three mirror EventIntentOutcome. `unsettled` reports a teardown
 * before any signal (runtime dispose). */
export type IntentConsequence = {
  kind: "consequenced" | "errored" | "dropped" | "refused" | "unsettled";
  reason?: string;
};

type OverlayEntry = {
  space: MemorySpace;
  localSeq: number;
  resolveVerdict: (verdict: SealedCommitVerdict) => void;
  /** The highest confirmed store seq this run's reads sat on — the
   * watermark threshold at which the authoritative derivation covers
   * everything this speculation consumed. */
  confirmedFloor: number;
  /** Docs this run read through PENDING (unpromoted) layers: unacked
   * authored origins (the user mid-typing), parked promotions, or
   * earlier speculation entries. The entry stays alive while any
   * UNACKED pending layer BELOW it remains on one of these docs
   * (speculation.md §4 step 3's keep-the-live-echo rule — an ACKED
   * layer whose promotion is merely parked no longer blocks: the wave
   * consumed the origin, so the authoritative coverage is real). */
  pendingReadDocs: Array<{ id: URI; scope?: CellScope }>;
  /** The localSeqs of the pending layers this run read through — its
   * ORIGINS. Retirement needs each origin ACKED with `W >= ackSeq`
   * (speculation.md §4 step 3); an origin that never acks (a retired
   * lower speculation, a rejected input) contributes no floor — the
   * store won upstream and the confirmed basis governs. */
  originLocalSeqs: number[];
  /** Resolves when the entry's verdict has been APPLIED (pending
   * dropped). Retirement chains a re-sweep on it: a chained entry
   * blocked on this one unblocks only after the drop, which is async
   * relative to the verdict — and on a quiet space no further
   * watermark event would re-sweep. */
  settled: Promise<unknown>;
  /** origin `intent(eventId)` (speculation.md §1): set on event-handler
   * echoes — the fired event's durable id. `retireIntent` withdraws by
   * it when the authoritative consequences (or the dropped-event
   * notice) arrive (speculation.md §4 step 2); the watermark sweep
   * stays the backstop. */
  eventId?: string;
};

/**
 * The overlay destination: one per non-serving Runtime under the flag,
 * created lazily by `Runtime.edit()` and consulted for every
 * transaction the runtime mints while no wave destination is installed.
 */
export class SpeculationOverlayDestination
  implements TransactionSealDestination {
  readonly #runtime: Runtime;
  /** space -> localSeq -> entry. */
  readonly #entries = new Map<MemorySpace, Map<number, OverlayEntry>>();
  /** space -> cancel fn for the watermark-doc sink driving retirement. */
  readonly #watermarkSinks = new Map<MemorySpace, () => void>();
  /** space -> release fn for the origin-accept wake installed on the
   * replica (speculation.md §4; leg-C 2026-08-13): a sweep that ran
   * while an origin's verdict was in flight skipped its entries as
   * blocked, and the covering watermark event has already passed — the
   * ack wake re-sweeps so a then-quiet space cannot strand them. */
  readonly #ackObserverReleases = new Map<MemorySpace, () => void>();
  /** space -> last observed watermark (for registration-time sweeps). */
  readonly #watermarks = new Map<MemorySpace, number>();
  /** Fired-intent notice watch (events.md §5, speculation.md §5):
   * space -> sidecarId -> eventIds awaiting their consequence signal.
   * Bounded by pending-intent count; the sidecar sink releases when its
   * last tracked id resolves. */
  readonly #trackedIntents = new Map<
    MemorySpace,
    Map<string, Set<string>>
  >();
  /** space\0sidecarId -> cancel fn for the sidecar-doc sink. */
  readonly #intentSinks = new Map<string, () => void>();
  /** Subscribers to terminal intent outcomes — the events.md §5 "the
   * client MUST be signaled so the UI can react" hook. */
  readonly #intentOutcomeSubscribers = new Set<
    (outcome: EventIntentOutcome) => void
  >();
  /** Per-intent consequence waiters (verdict blocker, 2026-08-12): the
   * send path's durable-ack coupling awaits an intent's TERMINAL
   * consequence — consequenced (server handling committed), errored,
   * dropped, or refused — so a caller's commit callback can no longer
   * report the speculative local run as durable success. Memoized
   * until consumed: the consequence may land before the waiter
   * registers. */
  readonly #intentConsequenceWaiters = new Map<
    string,
    Array<(outcome: IntentConsequence) => void>
  >();
  readonly #intentConsequenceMemo = new Map<string, IntentConsequence>();
  #closed = false;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** DIAGNOSTIC (tests): live overlay entries for a space. */
  entryCount(space: MemorySpace): number {
    return this.#entries.get(space)?.size ?? 0;
  }

  /** DIAGNOSTIC (tests): cumulative EVENT-HANDLER-kind seals this
   * overlay diverted — never decremented by retirement, so it
   * witnesses transient echoes deterministically. The Phase-4
   * receipt-race pin (independent review MINOR-3) counts on it: a
   * navigate-bearing fire's client half diverts exactly TWO
   * event-handler seals (the handler echo + the navigate-deferred
   * start), and a neutralized divert drops the second — the
   * authored-commit assert alone cannot see that, because the
   * neutralized start's authored commit usually LOSES its create-only
   * race to the serving side and vanishes whole. */
  #eventEchoSeals = 0;
  get eventEchoSealCount(): number {
    return this.#eventEchoSeals;
  }

  seal(tx: IExtendedStorageTransaction): Promise<Result<Unit, CommitError>> {
    const kind = speculationRunContextOf(tx)?.kind;
    if (kind !== "derivation" && kind !== "event-handler") {
      // Bookkeeping runs and unstamped transactions commit exactly as
      // today. Scheduler-stamped runs — derivations since Phase 2,
      // event handlers since Phase 3 (events.md §7: the F10 interim's
      // handler-write commit path is DELETED) — divert below.
      return tx.tx.commit();
    }
    return this.#sealSpeculative(tx);
  }

  async #sealSpeculative(
    tx: IExtendedStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    if (speculationRunContextOf(tx)?.kind === "event-handler") {
      this.#eventEchoSeals += 1;
    }
    if (this.#closed) {
      // A late derivation on a disposing runtime: nothing to render
      // into; drop the writes (the run's results are re-derivable by
      // construction).
      return { ok: {} };
    }
    const context = speculationRunContextOf(tx);
    // An event-handler-kind seal WITHOUT an eventId is refused LOUDLY
    // (review 2026-08-11 m5): such an entry has no intent to retire
    // against — no consequence signal will ever arrive for it — so the
    // divert would report ok while the write lands nowhere and no
    // server run reproduces it (silent loss). The one producer today
    // is llm-dialog's updateArgument (OW16's handler-class stamp with
    // no event); its full event-routing is owed — see
    // verification-coverage.md's owed register.
    if (context?.kind === "event-handler" && context.eventId === undefined) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "speculative event-handler seal refused: the run " +
            "carries no eventId, so the overlay entry could never " +
            "intent-retire and the write would be silently lost — an " +
            "event-handler-class client commit needs event routing " +
            "(events.md §5; speculation.md §5)",
          reason: new Error("speculation-event-handler-without-event"),
        },
      };
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      // Fail CLOSED: a transport without seal support must not fall
      // back to committing a derivation — that would re-open the
      // client derivation-commit path this destination exists to
      // remove (speculation.md §6's FORBIDDEN list).
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "speculative derivation refused: the storage " +
            "transaction does not support sealing, and committing a " +
            "derivation client-side is forbidden under " +
            "EXPERIMENTAL_SERVER_EXECUTION (speculation.md §6)",
          reason: new Error("speculation-seal-unsupported"),
        },
      };
    }
    const sealedSpaces: Array<{
      space: MemorySpace;
      entry: OverlayEntry;
    }> = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = this.#runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: `space replica for ${space} does not support sealing; ` +
                "speculative derivations cannot commit (speculation.md §6)",
              reason: new Error("speculation-seal-unsupported"),
            },
          });
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        const sealed = replica.sealNative(native, source, promise, {
          speculative: true,
        });
        let confirmedFloor = 0;
        for (const read of sealed.commit.reads.confirmed) {
          const seq = (read as { seq?: number }).seq ?? 0;
          if (seq > confirmedFloor) confirmedFloor = seq;
        }
        const pendingDocs = new Map<string, { id: URI; scope?: CellScope }>();
        const originLocalSeqs = new Set<number>();
        for (const read of sealed.commit.reads.pending) {
          const basis = (read as { basisSeq?: number }).basisSeq ?? 0;
          if (basis > confirmedFloor) confirmedFloor = basis;
          const key = `${read.scope ?? ""}\0${read.id}`;
          if (!pendingDocs.has(key)) {
            pendingDocs.set(key, { id: read.id as URI, scope: read.scope });
          }
          const layers = (read as { localSeq?: number | number[] }).localSeq;
          if (typeof layers === "number") originLocalSeqs.add(layers);
          else if (Array.isArray(layers)) {
            for (const layer of layers) originLocalSeqs.add(layer);
          }
        }
        const entry: OverlayEntry = {
          space,
          localSeq: sealed.localSeq,
          resolveVerdict: resolve,
          confirmedFloor,
          pendingReadDocs: [...pendingDocs.values()],
          originLocalSeqs: [...originLocalSeqs],
          settled: sealed.settled.catch(() => undefined),
          ...(context?.kind === "event-handler" &&
              context.eventId !== undefined
            ? { eventId: context.eventId }
            : {}),
        };
        sealedSpaces.push({ space, entry });
        return Promise.resolve({ ok: {} });
      },
      // Read-only-space dependencies (review thread r3739139506; stage
      // D's documented third bound): an implementation that gated
      // retirement on EACH read-only space's watermark was built and
      // REVERTED 2026-08-13 — the cross-space watermark subscriptions
      // and conservative blocking it added regressed the two-browsers
      // Phase-2 gate (bisect-verified: the gate stalls with the
      // machinery in, passes with it out). The bound therefore STANDS
      // as documented: a cross-space speculation can retire on its
      // written space's coverage while a read-only input is still
      // uncovered. `sealSpaceReads` is deliberately not implemented
      // here until a design that does not gate on foreign-space
      // watermark subscriptions exists (flagged in
      // verification-coverage.md's 2026-08-13 delta).
    };
    let result: Result<Unit, CommitError>;
    try {
      result = await inner.sealInto(collector);
    } catch (cause) {
      // A REJECTED sealInto (review thread r3739139536): without the
      // catch, entries already collected kept unresolved verdicts and
      // live pending writes forever. Withdraw them and surface a
      // CommitError like any other seal failure.
      const message = cause instanceof Error ? cause.message : String(cause);
      result = {
        error: {
          name: "StorageTransactionAborted",
          message: `speculative seal rejected: ${message}`,
          reason: cause,
        },
      };
    }
    if (result.error) {
      for (const { entry } of sealedSpaces) {
        entry.resolveVerdict({
          withdrawn: {
            message: `speculative seal failed: ${result.error.message}`,
          },
        });
      }
      return result;
    }
    if (this.#closed) {
      // The dispose race (review thread r3739139501): close() ran while
      // sealInto was in flight, so registering now would RESURRECT
      // entries close() can no longer withdraw (and their effects could
      // still enact). Same disposition as the early-closed arm: the
      // writes roll back (best-effort — the replica may be closing) and
      // the seal reports success (the run's results are re-derivable).
      for (const { entry } of sealedSpaces) {
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation overlay closed (runtime dispose)",
            superseded: true,
          },
        });
      }
      return { ok: {} };
    }
    for (const { space, entry } of sealedSpaces) {
      let entries = this.#entries.get(space);
      if (entries === undefined) {
        entries = new Map();
        this.#entries.set(space, entries);
      }
      entries.set(entry.localSeq, entry);
      this.#ensureWatermarkSink(space);
    }
    if (sealedSpaces.length > 0) {
      // A fresh entry may already be covered (a re-speculation after
      // retirement against state the watermark has passed): sweep once
      // off the current W, deferred a tick so the seal fully resolves
      // first.
      queueMicrotask(() => {
        for (const { space } of sealedSpaces) {
          this.#sweep(space, this.#watermarks.get(space) ?? 0);
        }
      });
    }
    return { ok: {} };
  }

  /**
   * Take ownership of a SPECULATIVE run's post-commit effects: enact
   * the reversible allowlisted kinds (navigateTo — optimistic
   * enactment), DROP everything else (the egress rule; the server's
   * authoritative run performs the real effect and its completion
   * arrives as a pushed derived commit). Non-derivation runs keep
   * today's inline flush.
   */
  deferSealedEffects(
    tx: IExtendedStorageTransaction,
    effects: readonly PostCommitSideEffect[],
  ): boolean {
    const kind = speculationRunContextOf(tx)?.kind;
    if (kind !== "derivation" && kind !== "event-handler") {
      return false;
    }
    if (this.#closed) {
      // The dispose race's effect half (review thread r3739139501): the
      // run's writes were (or will be) dropped by the closed seal path,
      // so even the reversible allowlisted kinds must not enact — an
      // optimistic navigation for a commit that was never accepted.
      // Still OWNED (true): a derivation's effects never take the
      // ordinary inline flush.
      return true;
    }
    const enactable = effects.filter((effect) =>
      SPECULATION_ENACTABLE_EFFECT_KINDS.has(effect.kind)
    );
    if (enactable.length > 0) {
      void (async () => {
        for (const effect of enactable) {
          try {
            // Phase 4 (protocol.md §5, T2.Q7): BEGIN the run's
            // deterministic nonce on the channel BEFORE the flush's
            // callback can run — the flush awaits an arbitrary
            // (possibly slow, async) navigateCallback, and the
            // authoritative intent can arrive on the effects channel
            // MID-flush; the in-flight record makes the channel
            // converge instead of double-navigating within one life
            // (LT8 accepts re-enactment only across a RELOAD). The
            // flush's OUTCOME rides with the record (owner review
            // P1-1): a FAILED flush retracts it, so the durable intent
            // re-enacts on a later delivery instead of being
            // acked-and-retired unenacted; a flush that no-ops on a
            // superseded attempt is deliberate non-enactment and
            // resolves as success — acking it is correct (a newer
            // attempt owns the navigation). Call order is safe: the
            // flush's callback is deferred to a microtask
            // (navigate-to.ts's Promise.resolve().then), so the
            // synchronous beginEnactment below records first.
            const flushed = Promise.resolve(effect.flush(tx));
            if (effect.nonce !== undefined) {
              void this.#runtime.effectsChannel?.beginEnactment(
                effect.nonce,
                flushed,
              );
            }
            await flushed;
          } catch (error) {
            logger.error(
              "speculative-enact-failed",
              "speculative post-commit enactment failed:",
              { kind: effect.kind, error },
            );
          }
        }
      })();
    }
    return true;
  }

  /**
   * Watch a fired intent's stream sidecar until its consequence signal
   * arrives (events.md §5; speculation.md §4 step 2, §5): the entry
   * marked `consequenced` retires the echo; `status: "dropped"` (the
   * conflicting-discharge notice) or an `error` consequence retires it
   * AND signals subscribers — the UI hook the ruling requires. The
   * watch reads the VALUE plane (the notice and the consequence mark
   * are ordinary doc writes riding the same first flush as the
   * consequences), so no commit-metadata carriage is needed; the
   * watermark sweep stays the backstop for signals this misses.
   */
  trackIntent(
    space: MemorySpace,
    sidecarId: string,
    eventId: string,
  ): void {
    if (this.#closed) return;
    let bySidecar = this.#trackedIntents.get(space);
    if (bySidecar === undefined) {
      bySidecar = new Map();
      this.#trackedIntents.set(space, bySidecar);
    }
    let ids = bySidecar.get(sidecarId);
    if (ids === undefined) {
      ids = new Set();
      bySidecar.set(sidecarId, ids);
    }
    ids.add(eventId);
    const sinkKey = `${space}\0${sidecarId}`;
    if (this.#intentSinks.has(sinkKey)) return;
    try {
      const cell = this.#runtime.getCellFromLink<StreamEventsDocValue>({
        space,
        id: sidecarId as never,
        scope: "space",
        path: [],
      });
      const cancel = cell.sink((value) => {
        this.#scanIntentNotices(
          space,
          sidecarId,
          value as StreamEventsDocValue | undefined,
        );
      });
      // The sink's IMMEDIATE callback may have resolved the last
      // tracked id (a duplicate fire whose consequence already landed
      // — round-2 thread T25): #untrackIntent then found no stored
      // cancel to release, so storing it NOW would leak the sidecar
      // subscription for the runtime's lifetime. Store only while ids
      // remain tracked; cancel otherwise.
      const stillTracked = this.#trackedIntents.get(space)?.get(sidecarId);
      if (stillTracked === undefined || stillTracked.size === 0) {
        try {
          cancel();
        } catch {
          // best-effort: the sink resolved everything it was for
        }
      } else {
        this.#intentSinks.set(sinkKey, cancel);
      }
    } catch (error) {
      logger.warn("intent-sink-failed", () => [
        `intent sidecar sink for ${space} failed; echo retirement for ` +
        "its events rides the watermark backstop only",
        error,
      ]);
    }
  }

  /** Resolve a tracked intent WITHOUT a store signal (a refused
   * delivery): retire its echo and signal subscribers. */
  resolveIntent(
    space: MemorySpace,
    sidecarId: string,
    eventId: string,
    outcome: { kind: "refused"; reason: string },
  ): void {
    if (this.#closed) return;
    this.#untrackIntent(space, sidecarId, eventId);
    this.retireIntent(space, eventId);
    this.#settleIntentConsequence(space, eventId, {
      kind: "refused",
      reason: outcome.reason,
    });
    this.#notifyIntentOutcome({
      space,
      eventId,
      kind: outcome.kind,
      reason: outcome.reason,
    });
  }

  /** Subscribe to terminal intent outcomes (dropped server-side, errored
   * server-side, refused at admission). Returns an unsubscribe fn. */
  subscribeIntentOutcomes(
    subscriber: (outcome: EventIntentOutcome) => void,
  ): () => void {
    this.#intentOutcomeSubscribers.add(subscriber);
    return () => this.#intentOutcomeSubscribers.delete(subscriber);
  }

  /** Await a fired intent's terminal consequence (see
   * IntentConsequence). Resolves immediately when the consequence
   * already landed; on overlay close, pending waiters settle
   * `unsettled`. */
  waitForIntentConsequence(
    space: MemorySpace,
    eventId: string,
  ): Promise<IntentConsequence> {
    const key = `${space}\0${eventId}`;
    const memo = this.#intentConsequenceMemo.get(key);
    if (memo !== undefined) {
      this.#intentConsequenceMemo.delete(key);
      return Promise.resolve(memo);
    }
    if (this.#closed) return Promise.resolve({ kind: "unsettled" });
    return new Promise((resolve) => {
      const waiters = this.#intentConsequenceWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.#intentConsequenceWaiters.set(key, waiters);
    });
  }

  #settleIntentConsequence(
    space: MemorySpace,
    eventId: string,
    outcome: IntentConsequence,
  ): void {
    const key = `${space}\0${eventId}`;
    const waiters = this.#intentConsequenceWaiters.get(key);
    if (waiters !== undefined && waiters.length > 0) {
      this.#intentConsequenceWaiters.delete(key);
      for (const resolve of waiters) resolve(outcome);
      return;
    }
    // Nobody waiting yet: memoize the FIRST terminal signal (bounded by
    // in-flight fires; consumed by the next waiter).
    if (!this.#intentConsequenceMemo.has(key)) {
      this.#intentConsequenceMemo.set(key, outcome);
    }
  }

  #notifyIntentOutcome(outcome: EventIntentOutcome): void {
    for (const subscriber of [...this.#intentOutcomeSubscribers]) {
      try {
        subscriber(outcome);
      } catch (error) {
        logger.warn("intent-outcome-subscriber-failed", () => [
          "event intent outcome subscriber threw",
          error,
        ]);
      }
    }
  }

  #scanIntentNotices(
    space: MemorySpace,
    sidecarId: string,
    value: StreamEventsDocValue | undefined,
  ): void {
    const ids = this.#trackedIntents.get(space)?.get(sidecarId);
    if (ids === undefined || ids.size === 0) return;
    for (const entry of value?.entries ?? []) {
      if (entry === null || typeof entry !== "object") continue;
      if (typeof entry.eventId !== "string" || !ids.has(entry.eventId)) {
        continue;
      }
      if (entry.status === "dropped") {
        // The conflicting-discharge notice (events.md §5, LT4/T7): the
        // echo un-renders instead of lingering as false state, and the
        // UI is signaled.
        this.#untrackIntent(space, sidecarId, entry.eventId);
        this.retireIntent(space, entry.eventId);
        this.#settleIntentConsequence(space, entry.eventId, {
          kind: "dropped",
          reason: entry.reason ?? "dropped",
        });
        this.#notifyIntentOutcome({
          space,
          eventId: entry.eventId,
          kind: "dropped",
          reason: entry.reason ?? "dropped",
        });
      } else if (entry.consequenced === true) {
        this.#untrackIntent(space, sidecarId, entry.eventId);
        this.retireIntent(space, entry.eventId);
        this.#settleIntentConsequence(
          space,
          entry.eventId,
          entry.error !== undefined
            ? { kind: "errored", reason: entry.error }
            : { kind: "consequenced" },
        );
        if (entry.error !== undefined) {
          // The handler threw server-side: the error IS the consequence
          // (events.md §5) — the echo still retires, and subscribers
          // hear the error outcome.
          this.#notifyIntentOutcome({
            space,
            eventId: entry.eventId,
            kind: "errored",
            reason: entry.error,
          });
        }
      }
    }
  }

  #untrackIntent(
    space: MemorySpace,
    sidecarId: string,
    eventId: string,
  ): void {
    const bySidecar = this.#trackedIntents.get(space);
    const ids = bySidecar?.get(sidecarId);
    if (ids === undefined) return;
    ids.delete(eventId);
    if (ids.size === 0) {
      bySidecar!.delete(sidecarId);
      const sinkKey = `${space}\0${sidecarId}`;
      const cancel = this.#intentSinks.get(sinkKey);
      if (cancel !== undefined) {
        this.#intentSinks.delete(sinkKey);
        try {
          cancel();
        } catch {
          // sink cancellation is best-effort
        }
      }
      if (bySidecar!.size === 0) this.#trackedIntents.delete(space);
    }
  }

  /**
   * Retire every overlay entry whose origin is `intent(eventId)`
   * (speculation.md §4 step 2): the authoritative consequences — or the
   * dropped-event notice — now exist, so the echo's job is done. Runs
   * ahead of watermark coverage (serving-loop.md §3's sealing-order
   * guarantee: consequences ride the FIRST flush even when W lags to
   * quiescence); the watermark sweep remains the backstop for entries
   * this never reaches.
   */
  retireIntent(space: MemorySpace, eventId: string): void {
    const entries = this.#entries.get(space);
    if (entries === undefined) return;
    for (const entry of [...entries.values()]) {
      if (entry.eventId !== eventId) continue;
      entries.delete(entry.localSeq);
      entry.resolveVerdict({
        withdrawn: {
          message: "event echo retired: the authoritative consequences " +
            "(or the dropped-event notice) arrived (speculation.md §4)",
          superseded: true,
        },
      });
      void entry.settled.then(() => {
        if (this.#closed) return;
        this.#sweep(space, this.#watermarks.get(space) ?? 0);
      });
    }
    if (entries.size === 0) this.#entries.delete(space);
  }

  #ensureWatermarkSink(space: MemorySpace): void {
    this.#ensureAckObserver(space);
    if (this.#watermarkSinks.has(space)) return;
    try {
      // Constructed INLINE from the wire-module constant rather than
      // through `executor/watermark.ts`: that module value-imports the
      // sqlite ENGINE (its server-side activation read), and this
      // module rides in every CLIENT bundle — the browser worker
      // included, where an engine import is fatal to the whole bundle.
      // The link shape is protocol.md §4's: the well-known doc, the
      // SPACE instance, the whole-document path.
      const cell = this.#runtime.getCellFromLink<{ seq?: number }>({
        space,
        id: SERVER_EXECUTION_WATERMARK_DOC_ID as never,
        scope: "space",
        path: [],
      });
      const cancel = cell.sink((value) => {
        const seq = (value as { seq?: number } | undefined)?.seq ?? 0;
        const known = this.#watermarks.get(space) ?? 0;
        if (seq > known) {
          this.#watermarks.set(space, seq);
        }
        this.#sweep(space, Math.max(seq, known));
      });
      this.#watermarkSinks.set(space, cancel);
    } catch (error) {
      logger.warn("watermark-sink-failed", () => [
        `watermark sink for ${space} failed; overlay retirement for the ` +
        "space will rely on entry re-runs",
        error,
      ]);
    }
  }

  /** Install the origin-accept wake (ISpaceReplica.speculationAckObserver)
   * on the space's replica: an entry whose sweep ran while its origin's
   * verdict was still in flight is BLOCKED at that sweep (unacked layer
   * below), and the covering watermark event has passed — on a
   * then-quiet space nothing else re-sweeps. Rejected origins reach the
   * overlay through the dependency cascade; accepts need this wake
   * (speculation.md §4; leg-C 2026-08-13). */
  #ensureAckObserver(space: MemorySpace): void {
    if (this.#ackObserverReleases.has(space)) return;
    try {
      const replica = this.#runtime.storageManager.open(space).replica;
      if (!("speculationAckObserver" in replica)) return;
      const observable = replica as {
        speculationAckObserver: (() => void) | undefined;
      };
      observable.speculationAckObserver = () => {
        if (this.#closed) return;
        this.#sweep(space, this.#watermarks.get(space) ?? 0);
      };
      this.#ackObserverReleases.set(space, () => {
        observable.speculationAckObserver = undefined;
      });
    } catch (error) {
      logger.warn("ack-observer-failed", () => [
        `origin-accept observer for ${space} failed; retirement of ` +
        "verdict-raced entries will rely on later watermark events",
        error,
      ]);
    }
  }

  /**
   * Retire every entry the watermark covers (speculation.md §4).
   * Iterates to a fixpoint within the event: retiring one entry can
   * unblock a chained one (a speculation that read another's overlay
   * value).
   */
  #sweep(space: MemorySpace, watermark: number): void {
    if (watermark <= 0) return;
    const entries = this.#entries.get(space);
    if (entries === undefined || entries.size === 0) return;
    const replica = this.#runtime.storageManager.open(space).replica;
    const view = replica.speculationRetirementView?.bind(replica);
    const ackedSeqOf = replica.ackedSeqOf?.bind(replica);
    if (view === undefined || ackedSeqOf === undefined) return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const entry of [...entries.values()]) {
        // The retirement floor (speculation.md §4 step 3): the highest
        // of the CONFIRMED read basis and every ORIGIN's ack seq — the
        // wave with `derivedThrough >= floor` has authoritatively
        // derived over everything this speculation consumed. The
        // CURRENT confirmed seq of a doc is deliberately NOT the floor:
        // the server's own derived write bumps it ABOVE any reachable W
        // on a quiet space (W covers inputs, never the derived commit's
        // own seq), which would strand the entry forever. The SEAL-TIME
        // read basis has a milder cousin of the same trap, accepted:
        // a re-speculation whose run READ a pushed derived value
        // carries that derived commit's seq in its confirmed basis, so
        // its floor exceeds every reachable W until the NEXT authored
        // input — the entry lingers on a then-quiet space (values
        // converge, rendering stays correct; each new input lifts the
        // previous generation).
        let floor = entry.confirmedFloor;
        let blocked = false;
        for (const origin of entry.originLocalSeqs) {
          const acked = ackedSeqOf(origin);
          if (acked !== undefined && acked > floor) floor = acked;
        }
        for (const doc of entry.pendingReadDocs) {
          const state = view(doc.id, doc.scope);
          // An UNACKED pending layer BELOW this entry blocks: an
          // in-flight authored origin (the user mid-typing) or a live
          // lower speculation entry. An ACKED layer whose promotion is
          // merely parked does not — the wave consumed it, and its
          // ack seq is already in the floor above.
          if (
            state.pendingLocalSeqs.some((seq) =>
              seq < entry.localSeq && ackedSeqOf(seq) === undefined
            )
          ) {
            blocked = true;
            break;
          }
        }
        if (blocked || watermark < floor) continue;
        entries.delete(entry.localSeq);
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation superseded by the authoritative " +
              "derivation (speculation.md §4: the store wins)",
            superseded: true,
          },
        });
        // A chained entry blocked on this one unblocks only once the
        // drop is APPLIED (async relative to the verdict): re-sweep
        // after settlement, off the freshest observed W — on a quiet
        // space no further watermark event would do it.
        void entry.settled.then(() => {
          if (this.#closed) return;
          this.#sweep(space, this.#watermarks.get(space) ?? 0);
        });
        progressed = true;
      }
    }
    if (entries.size === 0) {
      this.#entries.delete(space);
      // Keep the watermark sink: the next speculation for the space is
      // likely imminent, and the sink doubles as the client's settled
      // signal. It is released on close().
    }
  }

  /** Dispose: withdraw every live entry (the replica may already be
   * closing — rollback is best-effort) and release the watermark
   * sinks. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entries of this.#entries.values()) {
      for (const entry of entries.values()) {
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation overlay closed (runtime dispose)",
            superseded: true,
          },
        });
      }
      entries.clear();
    }
    this.#entries.clear();
    for (const cancel of this.#watermarkSinks.values()) {
      try {
        cancel();
      } catch {
        // sink cancellation is best-effort during teardown
      }
    }
    this.#watermarkSinks.clear();
    for (const cancel of this.#intentSinks.values()) {
      try {
        cancel();
      } catch {
        // sink cancellation is best-effort during teardown
      }
    }
    this.#intentSinks.clear();
    this.#trackedIntents.clear();
    this.#intentOutcomeSubscribers.clear();
    for (const waiters of this.#intentConsequenceWaiters.values()) {
      for (const resolve of waiters) resolve({ kind: "unsettled" });
    }
    this.#intentConsequenceWaiters.clear();
    this.#intentConsequenceMemo.clear();
    for (const release of this.#ackObserverReleases.values()) {
      try {
        release();
      } catch {
        // observer release is best-effort during teardown
      }
    }
    this.#ackObserverReleases.clear();
  }
}
