/**
 * Stitch — sync protocol using monotonic sequence numbers.
 *
 * Defines the message types from docs/specs/sync-protocol.md and provides a
 * stub server session. The stub accepts connections but errors on the first
 * incoming message, making the incomplete state visible at runtime.
 */

import type { FabricDatum } from "@commontools/data-model/fabric-value";
import { type Immutable, isRecord } from "@commontools/utils/types";
import type { MemorySpace, SchemaPathSelector, URI } from "./interface.ts";
export type { SchemaPathSelector };
import { ContextualFlowControl, type JSONSchema } from "@commontools/runner";
import {
  CompoundCycleTracker,
  getAtPath,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  SchemaObjectTraverser,
} from "@commontools/runner/traverse";
import { ExtendedStorageTransaction } from "../runner/src/storage/extended-storage-transaction.ts";

/** MIME type used for all stitch documents. */
const THE = "application/json";

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
  /** Plain-object form of SubscriptionSelector — safe to JSON round-trip. */
  selector: Record<string, SchemaPathSelector>;
};

export type ClientUnsubscribe = {
  type: "unsubscribe";
  /** Plain-object form of SubscriptionSelector — safe to JSON round-trip. */
  selector: Record<string, SchemaPathSelector>;
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
 * Sent in response to a subscribe request; carries current revisions for one
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

// ---------------------------------------------------------------------------
// Schema traversal helpers
// ---------------------------------------------------------------------------

/**
 * ObjectStorageManager backed by a StitchDb — used during subscribe to walk
 * schema links and discover related documents.
 */
class StitchObjectManager implements ObjectStorageManager {
  readonly #db: StitchDb;

  constructor(db: StitchDb) {
    this.#db = db;
  }

  load(address: { id: string; type: string }): IAttestation | null {
    if (address.type !== THE) return null;
    const row = this.#db.getDoc(address.id);
    if (row === null) return null;
    return {
      address: {
        id: address.id as URI,
        type: address.type as typeof THE,
        path: [],
      },
      value: row.value as Immutable<FabricDatum>,
    };
  }
}

/**
 * Walk the schema links of a single document using `SchemaObjectTraverser`
 * and return the set of all document IDs reachable from it (including the
 * root doc itself).
 */
function collectLinkedDocIds(
  db: StitchDb,
  spaceDid: string,
  uri: URI,
  selector: SchemaPathSelector,
): Set<string> {
  const row = db.getDoc(uri);
  // If selector has no schema, or the doc doesn't exist / lacks a value
  // wrapper, just return the root doc id.
  if (
    selector.schema === false ||
    selector.schema === undefined ||
    row === null ||
    !isRecord(row.value) ||
    !("value" in row.value)
  ) {
    return new Set([uri]);
  }

  const manager = new StitchObjectManager(db);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  const tracker = new CompoundCycleTracker<
    Immutable<FabricDatum>,
    JSONSchema | undefined
  >();
  const cfc = new ContextualFlowControl();
  const schemaTracker = new MapSetStringToPathSelectors(true);

  // Selector path from the client is relative to the value portion of the
  // document (e.g. []).  The traversal machinery expects it to be relative to
  // the fact's `is` field, so we prepend "value".
  const adjustedSelector: SchemaPathSelector = {
    schema: selector.schema,
    path: ["value", ...selector.path],
  };

  const rootDoc: IMemorySpaceValueAttestation = {
    address: {
      id: uri,
      type: THE,
      space: spaceDid as MemorySpace,
      path: ["value"],
    },
    value: (row.value as { value: Immutable<FabricDatum> }).value,
  };

  // getAtPath handles any pointer indirection at the root.
  const [navDoc, navSelector] = getAtPath(
    tx,
    rootDoc,
    adjustedSelector.path.slice(1), // strip "value" prefix consumed by rootDoc
    tracker,
    cfc,
    schemaTracker,
    adjustedSelector,
  );

  if (navSelector !== undefined && navDoc.value !== undefined) {
    const traverser = new SchemaObjectTraverser(
      tx,
      navSelector,
      tracker,
      schemaTracker,
      cfc,
    );
    traverser.traverse(navDoc);
  }

  // schemaTracker keys have the form `${space}/${id}/${type}`.
  // Extract just the doc ids belonging to this space.
  const prefix = `${spaceDid}/`;
  const suffix = `/${THE}`;
  const docIds = new Set<string>([uri]);
  for (const [key] of schemaTracker) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      docIds.add(key.slice(prefix.length, key.length - suffix.length));
    }
  }
  return docIds;
}

// ---------------------------------------------------------------------------
// SpaceHub
// ---------------------------------------------------------------------------

/**
 * Per-space state: one StitchDb, the active session set, and the per-document
 * revision windows needed to serve the spec's staleness rules without DB scans.
 *
 * Created lazily the first time a client connects to a space.
 */
class SpaceHub {
  readonly db: StitchDb;
  readonly spaceDid: string;
  readonly #sessions = new Set<StitchSession>();

  /** In-memory snapshots: serverSeq → docId → value. */
  readonly #snapshots = new Map<number, Map<string, unknown>>();

  /** Space-level commit history: serverSeq → ops, retained within the sliding window. */
  readonly #commits = new Map<number, CommitOp[]>();
  get commits(): ReadonlyMap<number, CommitOp[]> {
    return this.#commits;
  }

  /** docId → set of sessions subscribed to that document. */
  readonly #docSubscribers = new Map<string, Set<StitchSession>>();

  /**
   * session → set of docIds it is subscribed to.
   * Reverse index of #docSubscribers for efficient cleanup on disconnect.
   */
  readonly #sessionDocs = new Map<StitchSession, Set<string>>();

  constructor(db: StitchDb, spaceDid: string) {
    this.db = db;
    this.spaceDid = spaceDid;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  addSession(session: StitchSession): void {
    this.#sessions.add(session);
  }

  /** Remove a session. Call this when the WebSocket connection closes. */
  disconnect(session: StitchSession): void {
    this.#sessions.delete(session);
    const docs = this.#sessionDocs.get(session);
    if (docs) {
      for (const docId of docs) {
        this.#removeSubscriber(session, docId);
      }
      this.#sessionDocs.delete(session);
    }
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

  // -------------------------------------------------------------------------
  // Snapshot window management
  // -------------------------------------------------------------------------

  recordCommit(serverSeq: number, ops: CommitOp[]): void {
    this.#commits.set(serverSeq, ops);
  }

  recordRevision(docId: string, serverSeq: number, value: unknown): void {
    let snapshot = this.#snapshots.get(serverSeq);
    if (!snapshot) this.#snapshots.set(serverSeq, snapshot = new Map());
    snapshot.set(docId, value);
  }

  /**
   * Register `session` as a subscriber of `docId`.
   * The floor is derived from session.echoedServerSeq, not stored separately.
   */
  trackSubscription(session: StitchSession, docId: string): void {
    let subs = this.#docSubscribers.get(docId);
    if (!subs) this.#docSubscribers.set(docId, subs = new Set());
    subs.add(session);
    let docs = this.#sessionDocs.get(session);
    if (!docs) this.#sessionDocs.set(session, docs = new Set());
    docs.add(docId);
  }

  /**
   * Remove `session` from the subscribers of `docId`. Call this when the
   * client explicitly unsubscribes from a document.
   */
  untrackSubscription(session: StitchSession, docId: string): void {
    this.#removeSubscriber(session, docId);
    this.#sessionDocs.get(session)?.delete(docId);
  }

  /** The client's echoedServerSeq has advanced — GC snapshots and commits. */
  notifyFloorAdvanced(_session: StitchSession): void {
    for (const [seq, snapshot] of this.#snapshots) {
      for (const docId of snapshot.keys()) {
        const subscribers = this.#docSubscribers.get(docId);
        const needed = subscribers &&
          [...subscribers].some((s) => s.echoedServerSeq <= seq);
        if (!needed) snapshot.delete(docId);
      }
      if (snapshot.size === 0) this.#snapshots.delete(seq);
    }
    for (const [seq, ops] of this.#commits) {
      const needed = ops.some((op) => {
        const subscribers = this.#docSubscribers.get(op.id);
        return subscribers &&
          [...subscribers].some((s) => s.echoedServerSeq <= seq);
      });
      if (!needed) this.#commits.delete(seq);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  #removeSubscriber(session: StitchSession, docId: string): void {
    const subscribers = this.#docSubscribers.get(docId);
    if (!subscribers) return;
    subscribers.delete(session);
    if (subscribers.size === 0) this.#docSubscribers.delete(docId);
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
      space = new SpaceHub(StitchDb.open(dbPath), spaceDid);
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

  /** Exposed so SpaceHub can compute per-doc floors as min(session.echoedServerSeq). */
  get echoedServerSeq(): number {
    return this.#echoedServerSeq;
  }

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
    const serverSeq = db.currentServerSeq();
    const docs: Record<string, unknown> = {};

    for (const [key, selector] of Object.entries(msg.selector)) {
      if (key === "*") {
        this.#wildcardSubscription = true;
        continue;
      }

      // Walk the schema links of this doc to discover all reachable docs that
      // should be included in the initial snapshot.
      const linkedIds = collectLinkedDocIds(
        db,
        this.#hub.spaceDid,
        key as URI,
        selector,
      );

      for (const docId of linkedIds) {
        if (this.#subscriptions.has(docId)) continue;
        this.#subscriptions.add(docId);
        const row = db.getDoc(docId);
        if (row !== null) {
          docs[docId] = row.value;
          // Seed the revision window so the floor has something to anchor to.
          this.#hub.recordRevision(docId, row.server_seq, row.value);
        }
        this.#hub.trackSubscription(this, docId);
      }
    }

    this.#send({ type: "subscribed", serverSeq, docs });
  }

  #handleUnsubscribe(msg: ClientUnsubscribe): void {
    for (const key of Object.keys(msg.selector)) {
      if (key === "*") {
        this.#wildcardSubscription = false;
      } else {
        this.#subscriptions.delete(key);
        this.#hub.untrackSubscription(this, key);
      }
    }
  }

  #handleCommit(msg: ClientCommit): void {
    // GC stale tracking entries using the serverSeq the client has echoed.
    this.#gc(msg.serverSeq);

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
    // foreign commit after msg.serverSeq, using the in-memory revision window.
    if (msg.readSet.length > 0) {
      const ownSeqs = new Set(this.#integratedSeqs.values());
      if (
        [...this.#hub.commits].some(([seq, ops]) =>
          seq > msg.serverSeq && !ownSeqs.has(seq) && overlaps(msg.readSet, ops)
        )
      ) {
        this.#rejectedSeqs.set(msg.clientSeq, {
          serverSeq: msg.serverSeq,
          commit: msg,
        });
        this.#send({ type: "rejected", clientSeq: msg.clientSeq });
        return;
      }
    }

    // Accept: write to DB atomically, record revisions, and notify.
    const db = this.#hub.db;
    const newServerSeq = db.acceptCommit("", msg.ops, msg.signature);
    this.#hub.recordCommit(newServerSeq, msg.ops);
    for (const op of msg.ops) {
      if (op.op === "set") {
        this.#hub.recordRevision(op.id, newServerSeq, op.value);
      }
    }
    this.#integratedSeqs.set(`${msg.clientSeq}:${msg.serverSeq}`, newServerSeq);

    this.#send({
      type: "accepted",
      clientSeq: msg.clientSeq,
      serverSeq: newServerSeq,
    });
    this.#hub.broadcast(this, {
      type: "update",
      serverSeq: newServerSeq,
      ops: msg.ops,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Discard tracking entries the client has already processed. */
  #gc(clientEchoedServerSeq: number): void {
    if (clientEchoedServerSeq > this.#echoedServerSeq) {
      this.#echoedServerSeq = clientEchoedServerSeq;
      this.#hub.notifyFloorAdvanced(this);
    }
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

  const session = new StitchSession(
    space,
    (msg: ServerMessage) => enqueue(JSON.stringify(msg)),
  );

  const writable = new WritableStream<string>({
    write(chunk) {
      session.handleMessage(chunk);
    },
    close() {
      space.disconnect(session);
      closeReadable();
    },
    abort() {
      space.disconnect(session);
      closeReadable();
    },
  });

  space.addSession(session);

  return { readable, writable };
};
