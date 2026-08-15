// The client-side event-append queue (server-execution v2 Phase 3;
// events.md §5, speculation.md §5, LT9). Under the flag a client's
// handler fire commits ONLY the event — an authored append to the
// stream's sidecar doc (events.md §1, §7) — and this queue owns that
// commit's delivery: fired-order discharge, retry across transport
// loss and session replacement, and the duplicate-as-delivered
// classification the dedupe horizon makes sound.
//
// Why a queue and not a bare transact: events are INTENTS. Unlike an
// ordinary authored write — whose CAS staleness needs application-level
// repair, so the storage layer deliberately rejects it on transport
// death — an event append is safe to resubmit forever: admission
// dedupes by eventId above the stream's `eventWatermark`
// (events.md §4), the engine's replay check covers the same-session
// resend, and the server signals "already appended" with a NAMED error
// (`EventAppendDuplicateError`) precisely so a discharging client
// treats it as delivered rather than re-raising forever (events.md §5's
// duplicate-submission rule).
//
// Ordering: strictly one in-flight append per space, in fired order —
// events.md §5's "discharge on reconnect in fired order". (Per-stream
// order is the spec's requirement; per-space serialization implies it
// and keeps the machinery obvious.)
//
// Persistence class (LT9, RE-RULED 2026-08-15 — owner): the queue is
// PROCESS-LIFETIME. Queued-but-undischarged intents surviving a client
// RELOAD is a NON-GOAL this round — in the owner's words, the status quo
// does not survive a client + server reload either — so the queue rides
// an injectable {@link EventAppendQueueStore} whose ONE shipped
// implementation is in-memory and MANAGER-SHARED: it outlives any single
// SpaceReplica, so an in-process provisional-replica REPLACEMENT hands
// the successor queue the predecessor's undischarged intents (that
// in-process loss is machinery loss, not reload loss, and stays fixed).
// The durable Web-Storage adapter and the reload self-start path that
// Phase 3 carried for the earlier "durable" ruling are RETIRED with the
// re-ruling; the recorded future shape, if reload survival is ever
// wanted, is per-tab persistence + orphan adoption (verification-
// coverage.md's closed OW20 row). Sessions are per tab: one writer per
// session by construction, no leader election, no shared persisted
// session.

import { getLogger } from "@commonfabric/utils/logger";
import {
  type ClientCommit,
  type EventAppendDecl,
  type StreamEventEntry,
  type StreamLinkRef,
} from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/api";

const logger = getLogger("event-append-queue", {
  enabled: true,
  level: "warn",
});

/** One queued fire, exactly the durable shape (persisted verbatim). */
export type QueuedEventAppend = {
  /** The stream's sidecar doc ({@link streamEntriesDocId}). */
  sidecarId: string;
  /** The stream link the entry self-describes (events.md §1). */
  stream: StreamLinkRef;
  /** The durable client-minted event id (event-identity). */
  eventId: string;
  payload?: FabricValue;
  /** The one client-minted firedAt component (events.md §1): orders
   * this session's own appends and steers nothing. */
  clientSeq: number;
  runtimeInjectedEventKeys?: string[];
};

/** The delivery outcome one discharge resolves with. */
export type EventAppendOutcome =
  | { delivered: true; deduped?: boolean }
  | { delivered: false; refused: string };

/** The persistence seam (LT9, process-lifetime — see the header). Both
 * methods are best-effort from the queue's view — a failing store
 * degrades replacement survival, never liveness. */
export interface EventAppendQueueStore {
  load(space: string): Promise<QueuedEventAppend[]>;
  save(space: string, entries: readonly QueuedEventAppend[]): Promise<void>;
}

/** The in-memory store: the ONE shipped implementation. The storage
 * manager holds one per manager (shared across its replicas), which is
 * what carries a dead predecessor replica's intents to its successor. */
export const memoryEventAppendQueueStore = (): EventAppendQueueStore => {
  const bySpace = new Map<string, QueuedEventAppend[]>();
  return {
    load: (space) => Promise.resolve([...(bySpace.get(space) ?? [])]),
    save: (space, entries) => {
      bySpace.set(space, [...entries]);
      return Promise.resolve();
    },
  };
};

const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 10_000;

/**
 * OW27 — event-flood shaping (README §3.8; RULED (a) by the owner
 * 2026-08-15): the client's send path PACES per stream and never drops.
 * A per-stream token bucket sits between the queue head and the wire:
 * `burst` sends pass immediately, sustained sends drain at
 * `ratePerSecond`, and a flood (key-repeat driving `stream.send()`)
 * is HELD, in fired order, never coalesced and never dropped — events
 * are intent, and dropping loses it. Because the queue discharges one
 * append at a time in fired order (events.md §5), a paced head holds
 * everything behind it, streams included: cross-stream head-of-line
 * hold is the accepted cost of keeping fired order exact.
 *
 * The bound this imposes on the flooding user's OWN legitimate rapid
 * interactions is the dial: with N sends queued past the burst the
 * newest waits ≈ (N − burst) / ratePerSecond seconds. The default —
 * 20/s sustained, 20 burst — is a starting posture, FLAGGED for the
 * owner (Phase 7): a person's deliberate clicks never reach it, a
 * held key (≈30 Hz auto-repeat) is paced to 20 commits/s and clears
 * within half a second of release. `false` disables pacing (tests;
 * the OFF arm never constructs this queue).
 */
export type EventAppendPacing = {
  /** Sustained sends per second, per stream. */
  ratePerSecond: number;
  /** Bucket capacity: sends that pass immediately after a quiet spell. */
  burst: number;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
};

export const DEFAULT_EVENT_APPEND_PACING: Readonly<EventAppendPacing> = {
  ratePerSecond: 20,
  burst: 20,
};

/** Wire-error names that classify a discharge outcome. Everything not
 * named here is treated as TRANSIENT and retried with backoff — the
 * fail-open direction is deliberate: a mis-classified transient error
 * only delays delivery (dedupe keeps the resend sound), while
 * mis-classifying a transient as refused would LOSE a user intent. */
const REFUSED_ERROR_NAMES = new Set([
  // PROVABLY deterministic server verdicts only: resubmitting the
  // identical append can never succeed (shape violations, admission
  // refusals, CFC commit-rule refusals). The server's catch-all
  // "TransactionError" is NOT here — it names any unclassified
  // exception (a sqlite I/O fault, an engine bug), which a resend may
  // well clear; treating it as refused would LOSE a user intent on a
  // transient server fault (events.md §5's drop predicate is "cannot
  // run at all", never "the attempt faulted"). "ConflictError" is
  // likewise transient-shaped: a readless, precondition-less append
  // cannot deterministically conflict.
  "ProtocolError",
  "RowLabelCommitError",
  "PreconditionFailedError",
]);

export class EventAppendQueue {
  readonly #space: string;
  readonly #store: EventAppendQueueStore;
  readonly #transact: (commit: ClientCommit) => Promise<unknown>;
  readonly #nextLocalSeq: () => number;
  readonly #onRefused?: (append: QueuedEventAppend, reason: string) => void;
  readonly #queue: QueuedEventAppend[] = [];
  /** Keyed PER ENTRY OBJECT, not per eventId: duplicate-eventId fires
   * are a DESIGNED flow (events.md §5's duplicate submission), and a
   * per-id map would leak the first fire's outcome forever — wedging
   * every barrier its promise was registered with. Reloaded entries
   * carry no resolver (their firers are gone). */
  readonly #outcomes = new Map<
    QueuedEventAppend,
    (outcome: EventAppendOutcome) => void
  >();
  #clientSeq = 0;
  #draining = false;
  #closed = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves the drain loop's in-flight backoff wait — close() must
   * settle it (clearing the timer alone would leave the loop's await
   * pending forever, wedging dispose-time sanitizers). */
  #retryRelease: (() => void) | undefined;
  /** OW27 pacing: the per-stream token buckets (keyed by sidecar doc id
   * — one per stream), or undefined when pacing is disabled. */
  readonly #pacing: EventAppendPacing | undefined;
  readonly #buckets = new Map<string, { tokens: number; refilledAt: number }>();
  /** DIAGNOSTIC (tests): sends held by pacing so far. */
  #pacedHolds = 0;
  #loaded: Promise<void>;
  /** The tail of the save chain — `persisted` awaits it (tests, and
   * any caller that must observe durability before proceeding). */
  #lastPersist: Promise<void> = Promise.resolve();

  constructor(options: {
    space: string;
    /** Sends one ClientCommit; resolves on accept, rejects with the
     * (name-carrying) wire error otherwise. */
    transact: (commit: ClientCommit) => Promise<unknown>;
    /** Allocated at SEND time, per attempt — the increasing-localSeq
     * send-order discipline (04-protocol §3.9) forbids holding one
     * across other commits, and a session-replacement resubmit needs a
     * fresh one anyway. */
    nextLocalSeq: () => number;
    store?: EventAppendQueueStore;
    onRefused?: (append: QueuedEventAppend, reason: string) => void;
    /** OW27 per-stream send pacing; absent = the default posture,
     * `false` = unpaced. */
    pacing?: EventAppendPacing | false;
  }) {
    this.#space = options.space;
    this.#store = options.store ?? memoryEventAppendQueueStore();
    this.#transact = options.transact;
    this.#nextLocalSeq = options.nextLocalSeq;
    this.#onRefused = options.onRefused;
    this.#pacing = options.pacing === false
      ? undefined
      : options.pacing ?? DEFAULT_EVENT_APPEND_PACING;
    this.#loaded = this.#store.load(this.#space).then((persisted) => {
      // Intents a dead predecessor replica left in the manager-shared
      // store were fired EARLIER than anything this instance enqueues:
      // they discharge first.
      this.#queue.unshift(...persisted);
      for (const entry of persisted) {
        if (entry.clientSeq >= this.#clientSeq) {
          this.#clientSeq = entry.clientSeq + 1;
        }
      }
      if (persisted.length > 0) this.#kick();
    }).catch((error) => {
      logger.warn("event-queue-load-failed", () => [
        `event queue load for ${this.#space} failed; queued intents ` +
        "from a replaced predecessor replica (if any) are not recovered",
        error,
      ]);
    });
  }

  /** Live entries (pending discharge), fired order. */
  get pending(): readonly QueuedEventAppend[] {
    return this.#queue;
  }

  /** DIAGNOSTIC (tests): how many sends OW27 pacing has held so far. */
  get pacedHoldCount(): number {
    return this.#pacedHolds;
  }

  /** Resolves once the persisted backlog (if any) has been loaded. */
  get loaded(): Promise<void> {
    return this.#loaded;
  }

  /** Resolves when every save issued SO FAR has settled (durability
   * observation; a crash never waits for it). */
  get persisted(): Promise<void> {
    return this.#lastPersist;
  }

  nextClientSeq(): number {
    return this.#clientSeq++;
  }

  /** Queue one fire. Resolves with the delivery outcome (delivered /
   * deduped-as-delivered / refused). The caller does NOT have to await
   * it — the echo renders regardless (speculation.md §5). */
  enqueue(
    append: Omit<QueuedEventAppend, "clientSeq"> & { clientSeq?: number },
  ): Promise<EventAppendOutcome> {
    const { promise, resolve } = Promise.withResolvers<EventAppendOutcome>();
    // Sequenced BEHIND the backlog load (review 2026-08-11 / verdict
    // 2026-08-12): the load seeds #clientSeq past the persisted
    // entries, so a fire allocated BEFORE it completed could re-use a
    // persisted entry's clientSeq — breaking firedAt.clientSeq's
    // unique per-session append order. #loaded always settles (its
    // failure arm resolves), and same-source .then callbacks run in
    // registration order, so relative fired order is preserved.
    void this.#loaded.then(() => {
      const entry: QueuedEventAppend = {
        ...append,
        clientSeq: append.clientSeq ?? this.nextClientSeq(),
      };
      this.#queue.push(entry);
      this.#outcomes.set(entry, resolve);
      this.#persist();
      // Belt (review 2026-08-11 n2): an enqueue AFTER close() must still
      // settle its outcome — close() already swept the outcome map, so
      // without this the promise hangs any barrier it joins. The intent
      // itself stays queued+persisted for the next queue instance
      // (closed is not refused), exactly like close()'s own sweep.
      if (this.#closed) {
        this.#outcomes.delete(entry);
        resolve({ delivered: false, refused: "event queue closed" });
        return;
      }
      this.#kick();
    });
    return promise;
  }

  /** Nudge the discharge loop (reconnect, session replacement). */
  kick(): void {
    this.#kick();
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#retryRelease?.();
    this.#retryRelease = undefined;
    // Settle every outstanding outcome promise: a pending-commit
    // barrier holding one must release at teardown (the intents
    // themselves stay persisted for the next queue instance — closed
    // is not refused, so no echo is withdrawn).
    for (const [entry, resolve] of [...this.#outcomes.entries()]) {
      this.#outcomes.delete(entry);
      resolve({ delivered: false, refused: "event queue closed" });
    }
  }

  #persist(): void {
    // Serialized BEHIND the constructor's load (a save racing the load
    // would write only the fresh entries, clobbering the predecessor's
    // persisted backlog — the LT9 loss the seam exists to prevent) AND
    // behind the PREVIOUS save (review 2026-08-11 m6): an async
    // adapter that resolves saves out of order would otherwise leave
    // an OLDER queue snapshot durable after a newer one — chaining on
    // `#loaded` alone let save N+1 complete before save N. Every link
    // ends in catch, so a failed save degrades durability without
    // poisoning the chain.
    this.#lastPersist = this.#lastPersist
      .then(() => this.#loaded)
      .then(() => this.#store.save(this.#space, this.#queue))
      .catch((error) => {
        logger.warn("event-queue-save-failed", () => [
          `event queue save for ${this.#space} failed; a replica ` +
          "replacement before delivery may lose the queued intent",
          error,
        ]);
      });
  }

  #kick(): void {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    void this.#drain().finally(() => {
      this.#draining = false;
      // Entries that arrived while the loop wound down.
      if (this.#queue.length > 0 && !this.#closed) this.#kick();
    });
  }

  /**
   * OW27: wait for the head's stream to have a send token. Refills the
   * stream's bucket from the elapsed time (capped at `burst`), consumes
   * one token when available, else sleeps for the deficit — a closable
   * wait on the same release seam as the retry backoff, so close()
   * settles it. Never reorders: the head is the only send considered.
   */
  async #acquireSendToken(streamKey: string): Promise<void> {
    const pacing = this.#pacing;
    if (pacing === undefined) return;
    const now = pacing.now ?? Date.now;
    for (;;) {
      if (this.#closed) return;
      const at = now();
      let bucket = this.#buckets.get(streamKey);
      if (bucket === undefined) {
        bucket = { tokens: pacing.burst, refilledAt: at };
        this.#buckets.set(streamKey, bucket);
      } else {
        const elapsedS = Math.max(0, at - bucket.refilledAt) / 1000;
        bucket.tokens = Math.min(
          pacing.burst,
          bucket.tokens + elapsedS * pacing.ratePerSecond,
        );
        bucket.refilledAt = at;
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        // Housekeeping: a quiet stream's bucket refills to full and can
        // be forgotten (a fresh bucket starts full).
        if (this.#buckets.size > 64) {
          for (const [key, other] of this.#buckets) {
            if (key !== streamKey && other.tokens >= pacing.burst) {
              this.#buckets.delete(key);
            }
          }
        }
        return;
      }
      this.#pacedHolds += 1;
      const deficitMs = Math.max(
        1,
        Math.ceil(((1 - bucket.tokens) / pacing.ratePerSecond) * 1000),
      );
      await new Promise<void>((resolve) => {
        this.#retryRelease = resolve;
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = undefined;
          this.#retryRelease = undefined;
          resolve();
        }, deficitMs);
      });
    }
  }

  async #drain(): Promise<void> {
    await this.#loaded;
    let attempt = 0;
    while (this.#queue.length > 0 && !this.#closed) {
      const head = this.#queue[0];
      try {
        // OW27: pace per stream before the send (pace-never-drop; the
        // head holds everything behind it in fired order).
        await this.#acquireSendToken(head.sidecarId);
        if (this.#closed) break;
        await this.#transact(this.#commitFor(head));
        this.#settle(head, { delivered: true });
        attempt = 0;
      } catch (error) {
        const name = (error as { name?: string })?.name ?? "";
        const message = error instanceof Error ? error.message : String(error);
        if (name === "EventAppendDuplicateError") {
          // The first append landed; its consequences are (or will be)
          // the authoritative outcome (events.md §5).
          this.#settle(head, { delivered: true, deduped: true });
          attempt = 0;
          continue;
        }
        if (REFUSED_ERROR_NAMES.has(name)) {
          logger.warn("event-append-refused", () => [
            `event append ${head.eventId} refused deterministically; ` +
            "dropped from the queue",
            { name, message },
          ]);
          this.#settle(head, { delivered: false, refused: message });
          this.#onRefused?.(head, message);
          attempt = 0;
          continue;
        }
        // Transient (transport death, session replacement, handshake
        // in progress): keep the head queued and retry with backoff.
        // Delivery order holds — nothing behind the head sends first.
        attempt += 1;
        const delay = Math.min(
          RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 10),
          RETRY_CAP_MS,
        );
        await new Promise<void>((resolve) => {
          this.#retryRelease = resolve;
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.#retryRelease = undefined;
            resolve();
          }, delay);
        });
      }
    }
  }

  #settle(entry: QueuedEventAppend, outcome: EventAppendOutcome): void {
    const index = this.#queue.indexOf(entry);
    if (index >= 0) this.#queue.splice(index, 1);
    this.#persist();
    const resolve = this.#outcomes.get(entry);
    if (resolve !== undefined) {
      this.#outcomes.delete(entry);
      resolve(outcome);
    }
  }

  /** The append commit, built fresh per attempt: the tail-relative
   * merge patch (concurrent appends merge against durable state; the
   * array and path create if absent) plus the declaration admission
   * stamps from (events.md §1; the same shape the memory server's own
   * delegated delivery uses). Reads are EMPTY — admission is append
   * authority + the eventId CAS, never a base-revision check. */
  #commitFor(append: QueuedEventAppend): ClientCommit {
    const entry: StreamEventEntry = {
      eventId: append.eventId,
      stream: append.stream,
      payload: append.payload,
      firedAt: { clientSeq: append.clientSeq } as never,
      ...(append.runtimeInjectedEventKeys !== undefined
        ? { runtimeInjectedEventKeys: append.runtimeInjectedEventKeys }
        : {}),
    };
    const decl: EventAppendDecl = {
      id: append.sidecarId as EventAppendDecl["id"],
      eventId: append.eventId,
    };
    return {
      localSeq: this.#nextLocalSeq(),
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: append.sidecarId as never,
        patches: [{
          op: "append",
          path: "/value/entries",
          values: [entry as never],
        }],
      }],
      eventAppends: [decl],
    };
  }
}
