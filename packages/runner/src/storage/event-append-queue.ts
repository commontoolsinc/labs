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
// Durability (LT9, RULED 2026-08-03): the queue rides an injectable
// {@link EventAppendQueueStore} — "the same persistence class as
// `sessionId`" (events.md §5, protocol.md §5). Protocol §5's
// sessionId-persistence itself is unimplemented spec debt (today's
// sessionId is process-lifetime), so the DEFAULT store is in-memory —
// the same class — and a host that persists sessions supplies a durable
// store through the same seam. The contract tests drive a durable fake
// across queue instances; the browser adapter lands with the sessionId
// persistence work it depends on.

import { getLogger } from "@commonfabric/utils/logger";
import {
  type ClientCommit,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
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

/** The LT9 persistence seam. Both methods are best-effort from the
 * queue's view — a failing store degrades durability, never liveness. */
export interface EventAppendQueueStore {
  load(space: string): Promise<QueuedEventAppend[]>;
  save(space: string, entries: readonly QueuedEventAppend[]): Promise<void>;
}

/** An in-memory store: the default persistence class (see header). */
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

/** The subset of the Web Storage API the adapter needs (structural, so
 * hosts can hand in localStorage, sessionStorage, or a shim). */
export type WebStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * A Web-Storage-backed durable store (LT9; verdict blocker,
 * 2026-08-12): reload keeps queued-but-undischarged user intents.
 * Serialized through the memory boundary codec — the SAME encoding the
 * wire uses — so FabricValue payloads (registry symbols included)
 * round-trip with fidelity. `scope` partitions concurrent principals /
 * managers sharing one origin (pass something identity-derived).
 *
 * Hosts wire this through `Options.eventAppendQueueStore` wherever a
 * Storage API exists (browser main thread; Deno with --location). The
 * WORKER-hosted runtime has no Web Storage — its durable adapter is
 * the flagged OW20 follow-up (IndexedDB or a main-thread bridge).
 */
export const webStorageEventAppendQueueStore = (
  storage: WebStorageLike,
  scope: string,
): EventAppendQueueStore => {
  const keyOf = (space: string) => `cf:event-append-queue:${scope}:${space}`;
  return {
    load: (space) => {
      try {
        const raw = storage.getItem(keyOf(space));
        if (raw === null) return Promise.resolve([]);
        const decoded = decodeMemoryBoundary(raw);
        return Promise.resolve(
          Array.isArray(decoded)
            ? decoded as unknown as QueuedEventAppend[]
            : [],
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    save: (space, entries) => {
      try {
        if (entries.length === 0) {
          storage.removeItem(keyOf(space));
        } else {
          storage.setItem(
            keyOf(space),
            encodeMemoryBoundary(entries as unknown as FabricValue),
          );
        }
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
};

const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 10_000;

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
  }) {
    this.#space = options.space;
    this.#store = options.store ?? memoryEventAppendQueueStore();
    this.#transact = options.transact;
    this.#nextLocalSeq = options.nextLocalSeq;
    this.#onRefused = options.onRefused;
    this.#loaded = this.#store.load(this.#space).then((persisted) => {
      // Persisted intents fired EARLIER than anything this instance
      // enqueues (they survived a reload): they discharge first.
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
        "from a previous session (if any) are not recovered",
        error,
      ]);
    });
  }

  /** Live entries (pending discharge), fired order. */
  get pending(): readonly QueuedEventAppend[] {
    return this.#queue;
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
          `event queue save for ${this.#space} failed; a reload before ` +
          "delivery may lose the queued intent (LT9 durability degraded)",
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

  async #drain(): Promise<void> {
    await this.#loaded;
    let attempt = 0;
    while (this.#queue.length > 0 && !this.#closed) {
      const head = this.#queue[0];
      try {
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
