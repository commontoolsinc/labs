/**
 * Stitch — sync protocol using monotonic sequence numbers.
 *
 * Defines the message types from docs/specs/sync-protocol.md and provides a
 * stub server session. The stub accepts connections but errors on the first
 * incoming message, making the incomplete state visible at runtime.
 */

import type { FabricDatum } from "@commontools/data-model/fabric-value";
import type { Immutable } from "@commontools/utils/types";
import type { SchemaPathSelector, URI } from "./interface.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Describes which documents a client wants to subscribe to, and with what
 * schema granularity. The key "*" matches all documents in the space.
 */
export type SubscriptionSelector = Map<URI | "*", SchemaPathSelector>;

/**
 * The set of documents a client read when authoring a commit. The server uses
 * this to determine whether any of those reads have been invalidated by
 * concurrent commits.
 */
export type ReadSet = URI[];

/** A single operation within a commit. */
export type CommitOp = {
  op: "set";
  id: URI;
  path: readonly string[];
  value: Immutable<FabricDatum>;
};

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export type ClientCommit = {
  type: "commit";
  /** Client's monotonic message id for this session. */
  clientSeq: number;
  /** Latest global serverSeq the client has processed. */
  serverSeq: number;
  readSet: ReadSet;
  ops: CommitOp[];
  signature: string;
};

export type ClientSubscribe = {
  type: "subscribe";
  selector: SubscriptionSelector;
};

export type ClientUnsubscribe = {
  type: "unsubscribe";
  selector: SubscriptionSelector;
};

export type ClientMessage = ClientCommit | ClientSubscribe | ClientUnsubscribe;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

/** Sent to the originating client when a commit is accepted into canonical history. */
export type ServerAccepted = {
  type: "accepted";
  clientSeq: number;
  serverSeq: number;
};

/** Sent to the originating client when a commit is rejected. */
export type ServerRejected = {
  type: "rejected";
  clientSeq: number;
};

/**
 * Sent in response to a subscribe request; carries current snapshots for one
 * or more docs. The serverSeq here becomes this client's floor for snapshot
 * retention.
 */
export type ServerSubscribed = {
  type: "subscribed";
  serverSeq: number;
  docs: Record<string, unknown>;
};

/**
 * Subscription update sent to all clients subscribed to at least one document
 * touched by a commit, excluding the originating client.
 */
export type ServerUpdate = {
  type: "update";
  serverSeq: number;
  ops: CommitOp[];
};

export type ServerMessage =
  | ServerAccepted
  | ServerRejected
  | ServerSubscribed
  | ServerUpdate;

// ---------------------------------------------------------------------------
// Server hub and per-client session
// ---------------------------------------------------------------------------

import { StitchDb } from "./stitch-db.ts";

/**
 * Per-space state: one StitchDb and the set of sessions currently connected
 * to that space. Created lazily the first time a client connects to a space.
 */
class SpaceHub {
  readonly db: StitchDb;
  readonly #sessions = new Set<StitchSession>();

  constructor(db: StitchDb) {
    this.db = db;
  }

  addSession(session: StitchSession): void {
    this.#sessions.add(session);
  }

  removeSession(session: StitchSession): void {
    this.#sessions.delete(session);
  }

  /** Broadcast an update to all sessions in this space except the originator. */
  broadcast(origin: StitchSession, update: ServerUpdate): void {
    const touchedIds = update.ops.map((op) => op.id);
    for (const session of this.#sessions) {
      if (session !== origin && session.isSubscribedToAny(touchedIds)) {
        session.send(update);
      }
    }
  }
}

/**
 * Registry of per-space hubs for one running memory server. One instance is
 * created at startup and shared across all WebSocket connections.
 *
 * Space databases are opened lazily on first connection using the same naming
 * convention as the legacy system: `{store}/{spaceDid}.sqlite`.
 */
export class StitchHub {
  readonly #store: URL;
  readonly #spaces = new Map<string, SpaceHub>();

  constructor(store: URL) {
    this.#store = store;
  }

  /** Get (or lazily open) the SpaceHub for the given space DID. */
  #space(spaceDid: string): SpaceHub {
    let space = this.#spaces.get(spaceDid);
    if (!space) {
      const dbPath = new URL(`./${spaceDid}.sqlite`, this.#store).pathname;
      space = new SpaceHub(StitchDb.open(dbPath));
      this.#spaces.set(spaceDid, space);
    }
    return space;
  }

  /** Create a session scoped to the given space. */
  createSession(
    spaceDid: string,
  ): { readable: ReadableStream<string>; writable: WritableStream<string> } {
    return createSession(this.#space(spaceDid));
  }
}

/**
 * Per-client state for one WebSocket connection.
 *
 * Tracks active subscriptions, in-flight commit accounting (rejectedSeqs /
 * integratedSeqs), and the latest serverSeq echoed by this client.
 */
class StitchSession {
  readonly #hub: SpaceHub;
  readonly #send: (msg: ServerMessage) => void;

  /** Whether this client is subscribed to all documents in the space. */
  #wildcardSubscription = false;
  /** docIds this client is explicitly subscribed to. */
  readonly #subscriptions = new Set<string>();

  /**
   * clientSeq → { serverSeq at rejection, original commit }
   * Used to propagate rejections through the pending chain.
   */
  readonly #rejectedSeqs = new Map<
    number,
    { serverSeq: number; commit: ClientCommit }
  >();

  /**
   * "clientSeq:serverSeqAtSubmission" → assigned serverSeq
   * Lets staleness checks skip the client's own prior integrated commits.
   */
  readonly #integratedSeqs = new Map<string, number>();

  /** Latest serverSeq echoed by this client in an incoming commit message. */
  #echoedServerSeq = 0;

  constructor(hub: SpaceHub, send: (msg: ServerMessage) => void) {
    this.#hub = hub;
    this.#send = send;
  }

  isSubscribedToAny(docIds: string[]): boolean {
    if (this.#wildcardSubscription) return true;
    return docIds.some((id) => this.#subscriptions.has(id));
  }

  send(msg: ServerMessage): void {
    this.#send(msg);
  }

  handleMessage(chunk: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(chunk) as ClientMessage;
    } catch {
      return; // discard malformed input
    }

    switch (msg.type) {
      case "subscribe":
        this.#handleSubscribe(msg);
        break;
      case "unsubscribe":
        this.#handleUnsubscribe(msg);
        break;
      case "commit":
        this.#handleCommit(msg);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  #handleSubscribe(msg: ClientSubscribe): void {
    const db = this.#hub.db;
    const docs: Record<string, unknown> = {};

    for (const [key] of msg.selector) {
      if (key === "*") {
        this.#wildcardSubscription = true;
      } else {
        this.#subscriptions.add(key);
        const row = db.getDoc(key);
        if (row !== null) {
          docs[key] = row.value;
        }
      }
    }

    this.#send({
      type: "subscribed",
      serverSeq: db.currentServerSeq(),
      docs,
    });
  }

  #handleUnsubscribe(msg: ClientUnsubscribe): void {
    for (const [key] of msg.selector) {
      if (key === "*") {
        this.#wildcardSubscription = false;
      } else {
        this.#subscriptions.delete(key);
      }
    }
  }

  #handleCommit(msg: ClientCommit): void {
    // GC stale tracking entries using the serverSeq the client has echoed.
    this.#gc(msg.serverSeq);
    this.#echoedServerSeq = msg.serverSeq;

    // Rule 1: Pending chain — reject if any prior rejected commit's writes
    // overlap with this commit's reads.
    for (const [, rejected] of this.#rejectedSeqs) {
      if (overlaps(msg.readSet, rejected.commit.ops)) {
        this.#rejectedSeqs.set(msg.clientSeq, {
          serverSeq: msg.serverSeq,
          commit: msg,
        });
        this.#send({ type: "rejected", clientSeq: msg.clientSeq });
        return;
      }
    }

    // Rule 2: Staleness — reject if any doc in the read set was written by a
    // foreign commit between msg.serverSeq and the current serverSeq.
    const db = this.#hub.db;
    const currentSeq = db.currentServerSeq();

    if (msg.readSet.length > 0 && msg.serverSeq < currentSeq) {
      const integratedServerSeqs = new Set(this.#integratedSeqs.values());
      const intervening = db.getCommitsBetween(msg.serverSeq, currentSeq);

      for (const commit of intervening) {
        // Skip this client's own previously integrated commits.
        if (integratedServerSeqs.has(commit.server_seq)) continue;
        if (overlaps(msg.readSet, commit.ops)) {
          this.#rejectedSeqs.set(msg.clientSeq, {
            serverSeq: msg.serverSeq,
            commit: msg,
          });
          this.#send({ type: "rejected", clientSeq: msg.clientSeq });
          return;
        }
      }
    }

    // Accept: write to DB atomically and notify.
    const newServerSeq = db.acceptCommit("", msg.ops, msg.signature);
    this.#integratedSeqs.set(`${msg.clientSeq}:${msg.serverSeq}`, newServerSeq);

    this.#send({ type: "accepted", clientSeq: msg.clientSeq, serverSeq: newServerSeq });
    this.#hub.broadcast(this, { type: "update", serverSeq: newServerSeq, ops: msg.ops });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Discard tracking entries the client has already processed. */
  #gc(clientEchoedServerSeq: number): void {
    for (const [seq, { serverSeq }] of this.#rejectedSeqs) {
      if (serverSeq < clientEchoedServerSeq) this.#rejectedSeqs.delete(seq);
    }
    for (const [key, assignedSeq] of this.#integratedSeqs) {
      if (assignedSeq < clientEchoedServerSeq) this.#integratedSeqs.delete(key);
    }
  }
}

/**
 * Doc-level overlap check: returns true if any URI in `readSet` appears in
 * the write set of `ops`.
 */
function overlaps(readSet: ReadSet, ops: CommitOp[]): boolean {
  const written = new Set(ops.map((op) => op.id));
  return readSet.some((uri) => written.has(uri));
}

// ---------------------------------------------------------------------------
// Session factory (module-private, called via StitchHub.createSession)
// ---------------------------------------------------------------------------

/**
 * Create a stream pair for one WebSocket connection scoped to `space`.
 *
 * Returns a `{ readable, writable }` pair — wire the readable to the client's
 * outbound stream and the writable to the client's inbound stream. The
 * SpaceHub's broadcast mechanism pushes messages to the readable independently
 * of the writable, which is why this cannot be a plain TransformStream.
 */
const createSession = (
  space: SpaceHub,
): { readable: ReadableStream<string>; writable: WritableStream<string> } => {
  let enqueue: (msg: string) => void = () => {};
  let closeReadable: () => void = () => {};

  const readable = new ReadableStream<string>({
    start(controller) {
      enqueue = (msg) => controller.enqueue(msg);
      closeReadable = () => controller.close();
    },
  });

  const session = new StitchSession(space, (msg: ServerMessage) =>
    enqueue(JSON.stringify(msg))
  );

  const writable = new WritableStream<string>({
    write(chunk) {
      session.handleMessage(chunk);
    },
    close() {
      space.removeSession(session);
      closeReadable();
    },
    abort() {
      space.removeSession(session);
      closeReadable();
    },
  });

  space.addSession(session);

  return { readable, writable };
};
