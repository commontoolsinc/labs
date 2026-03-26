/**
 * StitchStorageProvider — client-side IStorageProviderWithReplica backed by
 * the stitch WebSocket sync protocol.
 *
 * Replaces the UCAN-based Provider/ProviderConnection when the stitch feature
 * flag is enabled (getStitchConfig() === true).
 */

import { assert } from "@commontools/memory/fact";
import type { FabricDatum } from "@commontools/data-model/fabric-value";
import type {
  Fact,
  ISpaceReplica,
  IStorageProviderWithReplica,
  IStorageSubscription,
  IStorageTransaction,
  ITransaction,
  MediaType,
  MemorySpace,
  Result,
  SchemaPathSelector,
  State,
  StorageTransactionRejected,
  Unit,
  URI,
} from "./interface.ts";
import type {
  ClientCommit,
  ClientMessage,
  CommitOp,
  ServerMessage,
  ServerSubscribed,
  ServerUpdate,
} from "../../../memory/stitch.ts";
import * as Differential from "./differential.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THE = "application/json" as MediaType;

const DEFAULT_SELECTOR: SchemaPathSelector = { schema: true, path: [] };
const storeError = (message: string): StorageTransactionRejected =>
  ({
    name: "StoreError" as const,
    message,
    cause: { name: "StoreError" as const, message },
  }) as StorageTransactionRejected;

// ---------------------------------------------------------------------------
// StitchReplica
// ---------------------------------------------------------------------------

type CommitHandler = (
  ops: CommitOp[],
  readSet: URI[],
  source?: IStorageTransaction,
) => Promise<Result<Unit, StorageTransactionRejected>>;

/**
 * Local replica for one space in the stitch protocol.
 *
 * Stores the current committed value of each document as an Assertion, so the
 * Chronicle layer (used by the transaction system) can read and build causal
 * chains from it.
 */
export class StitchReplica implements ISpaceReplica {
  readonly #space: MemorySpace;
  readonly #store = new Map<string, State>();
  readonly #subscription: IStorageSubscription;
  #commitHandler: CommitHandler | null = null;

  constructor(space: MemorySpace, subscription: IStorageSubscription) {
    this.#space = space;
    this.#subscription = subscription;
  }

  did(): MemorySpace {
    return this.#space;
  }

  /** Called once by StitchConnection so commits can be forwarded. */
  setCommitHandler(handler: CommitHandler): void {
    this.#commitHandler = handler;
  }

  #key(id: string): string {
    return `${THE}\0${id}`;
  }

  get(entry: { id: URI }): State | undefined {
    return this.#store.get(this.#key(entry.id));
  }

  // -------------------------------------------------------------------------
  // Internal state management (called by StitchConnection)
  // -------------------------------------------------------------------------

  /**
   * Apply a batch of CommitOps to local state, chaining causes from the
   * existing stored assertion, and emit a storage notification.
   *
   * Pass `source` to emit a "commit" notification (originating client); omit
   * it to emit an "integrate" notification (remote peer update).
   */
  applyOps(ops: CommitOp[], source?: IStorageTransaction): void {
    const changes = Differential.create();
    for (const op of ops) {
      if (op.op !== "set") continue;
      const key = this.#key(op.id);
      const prev = this.#store.get(key);
      const before = prev?.is;

      // Build the new assertion chaining from the previous fact (if any).
      // If prev is Unclaimed or absent, assert treats cause:null as unclaimedRef.
      const prevFact = prev !== undefined && prev.cause !== undefined
        ? prev as Fact
        : null;
      const newState = assert({
        the: THE,
        of: op.id,
        is: op.value as FabricDatum,
        cause: prevFact,
      });
      this.#store.set(key, newState);
      changes.add({
        address: { id: op.id as URI, type: THE, path: [] },
        before,
        after: op.value,
      });
    }

    this.#subscription.next(
      source
        ? { type: "commit", space: this.#space, changes, source }
        : { type: "integrate", space: this.#space, changes },
    );
  }

  /** Revert a prior applyOps, restoring snapshots and emitting "revert". */
  revertOps(
    ops: CommitOp[],
    snapshots: Map<string, State | undefined>,
    reason: StorageTransactionRejected,
    source?: IStorageTransaction,
  ): void {
    const changes = Differential.create();
    for (const op of ops) {
      if (op.op !== "set") continue;
      const key = this.#key(op.id);
      const current = this.#store.get(key);
      const prev = snapshots.get(key);
      if (prev !== undefined) {
        this.#store.set(key, prev);
      } else {
        this.#store.delete(key);
      }
      changes.add({
        address: { id: op.id as URI, type: THE, path: [] },
        before: current?.is,
        after: prev?.is,
      });
    }
    this.#subscription.next({
      type: "revert",
      space: this.#space,
      changes,
      reason,
      ...(source ? { source } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // ISpaceReplica
  // -------------------------------------------------------------------------

  async commit(
    transaction: ITransaction,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    if (!this.#commitHandler) {
      return {
        error: storeError("StitchReplica: no commit handler (not connected)"),
      };
    }

    // Convert Assertions → CommitOps (Retractions are not yet supported by
    // the stitch protocol and are silently skipped).
    const ops: CommitOp[] = [];
    for (const fact of transaction.facts) {
      if (fact.is !== undefined) {
        ops.push({
          op: "set",
          id: fact.of,
          path: [],
          value: fact.is,
        });
      }
    }

    // Convert Invariants → read-set (just the URIs, deduplicated).
    const readSet: URI[] = [...new Set(transaction.claims.map((c) => c.of))];

    // Snapshot current state so we can revert on rejection.
    const snapshots = new Map<string, State | undefined>();
    for (const op of ops) {
      const key = this.#key(op.id);
      snapshots.set(key, this.#store.get(key));
    }

    // For ops derived from Assertions in the transaction, we store the
    // Assertion itself (with its causal chain) rather than recreating it,
    // so the Chronicle layer sees a consistent chain on subsequent reads.
    for (const fact of transaction.facts) {
      if (fact.is !== undefined) {
        this.#store.set(this.#key(fact.of), fact);
      }
    }

    // Emit an optimistic "commit" notification.
    const commitChanges = Differential.create();
    for (const op of ops) {
      const key = this.#key(op.id);
      commitChanges.add({
        address: { id: op.id as URI, type: THE, path: [] },
        before: snapshots.get(key)?.is,
        after: op.value,
      });
    }
    if (ops.length > 0) {
      this.#subscription.next({
        type: "commit",
        space: this.#space,
        changes: commitChanges,
        source,
      });
    }

    // Send the commit to the server and await the response.
    const result = await this.#commitHandler(ops, readSet, source);

    if (result.error) {
      this.revertOps(ops, snapshots, result.error, source);
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// StitchConnection
// ---------------------------------------------------------------------------

interface StitchConnectionOptions {
  address: URL;
  space: MemorySpace;
  replica: StitchReplica;
}

/**
 * Manages the WebSocket lifecycle for one space's stitch session.
 *
 * Sends and receives stitch protocol messages, routing incoming updates to the
 * local replica and resolving pending commit/subscribe promises.
 */
class StitchConnection {
  readonly #address: URL;
  readonly #space: MemorySpace;
  readonly #replica: StitchReplica;

  #ws: WebSocket | null = null;
  #serverSeq = 0;
  #clientSeq = 0;
  #destroyed = false;

  /** Messages buffered while the WebSocket is connecting. */
  readonly #sendQueue: ClientMessage[] = [];

  /** FIFO queue of pending subscribe resolvers — each subscribe message
   *  generates exactly one subscribed response from the server. */
  readonly #pendingSubscribes: Array<
    (result: Result<Unit, Error>) => void
  > = [];

  /** clientSeq → resolver for in-flight commit messages. */
  readonly #pendingCommits = new Map<
    number,
    (result: Result<Unit, StorageTransactionRejected>) => void
  >();

  /** All in-flight promises, for synced(). */
  readonly #pendingPromises = new Set<Promise<unknown>>();

  constructor(options: StitchConnectionOptions) {
    this.#address = options.address;
    this.#space = options.space;
    this.#replica = options.replica;
    this.#replica.setCommitHandler(this.#handleCommit.bind(this));
    this.#connect();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  subscribe(
    uri: URI,
    selector: SchemaPathSelector = DEFAULT_SELECTOR,
  ): Promise<Result<Unit, Error>> {
    const { promise, resolve } = Promise.withResolvers<Result<Unit, Error>>();
    this.#pendingSubscribes.push(resolve);
    this.#track(promise);

    this.#send({ type: "subscribe", selector: { [uri]: selector } });
    return promise;
  }

  synced(): Promise<void> {
    return Promise.all([...this.#pendingPromises]).then(() => {});
  }

  destroy(): void {
    this.#destroyed = true;
    this.#ws?.close();
    this.#sendQueue.length = 0;
    // Reject all pending promises so callers don't hang.
    const err = storeError("connection destroyed");
    for (const resolve of this.#pendingSubscribes.splice(0)) {
      resolve({ error: err as unknown as Error });
    }
    for (const resolve of this.#pendingCommits.values()) {
      resolve({ error: err });
    }
    this.#pendingCommits.clear();
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  #connect(): void {
    if (this.#destroyed) return;

    const url = new URL(this.#address.href);
    url.searchParams.set("space", this.#space);
    const ws = new WebSocket(url.href);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      // Flush any messages that arrived before the connection opened.
      for (const msg of this.#sendQueue.splice(0)) {
        ws.send(JSON.stringify(msg));
      }
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      this.#onMessage(event.data as string);
    });

    ws.addEventListener("close", () => {
      this.#ws = null;
      if (!this.#destroyed) {
        setTimeout(() => this.#connect(), 1000);
      }
    });

    ws.addEventListener("error", () => {
      // The "close" event fires after an error; reconnect is handled there.
    });
  }

  #send(msg: ClientMessage): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    } else {
      // Buffer the message until the connection opens.
      this.#sendQueue.push(msg);
    }
  }

  #track(promise: Promise<unknown>): void {
    this.#pendingPromises.add(promise);
    promise.finally(() => this.#pendingPromises.delete(promise));
  }

  // -------------------------------------------------------------------------
  // Incoming message handling
  // -------------------------------------------------------------------------

  #onMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "subscribed":
        return this.#onSubscribed(msg);
      case "update":
        return this.#onUpdate(msg);
      case "accepted":
        return this.#onAccepted(msg);
      case "rejected":
        return this.#onRejected(msg);
    }
  }

  #onSubscribed(msg: ServerSubscribed): void {
    this.#serverSeq = Math.max(this.#serverSeq, msg.serverSeq);

    // Seed replica with initial document values.
    const ops: CommitOp[] = Object.entries(msg.docs).map(([id, value]) => ({
      op: "set",
      id: id as URI,
      path: [],
      value: value as FabricDatum,
    }));
    if (ops.length > 0) this.#replica.applyOps(ops);

    // Resolve the oldest pending subscribe (FIFO).
    this.#pendingSubscribes.shift()?.({ ok: {} });
  }

  #onUpdate(msg: ServerUpdate): void {
    this.#serverSeq = Math.max(this.#serverSeq, msg.serverSeq);
    this.#replica.applyOps(msg.ops);
  }

  #onAccepted(
    msg: { type: "accepted"; clientSeq: number; serverSeq: number },
  ): void {
    this.#serverSeq = Math.max(this.#serverSeq, msg.serverSeq);
    const resolve = this.#pendingCommits.get(msg.clientSeq);
    if (resolve) {
      this.#pendingCommits.delete(msg.clientSeq);
      resolve({ ok: {} });
    }
  }

  #onRejected(msg: { type: "rejected"; clientSeq: number }): void {
    const resolve = this.#pendingCommits.get(msg.clientSeq);
    if (resolve) {
      this.#pendingCommits.delete(msg.clientSeq);
      resolve({ error: storeError("commit rejected by server") });
    }
  }

  // -------------------------------------------------------------------------
  // Commit dispatch
  // -------------------------------------------------------------------------

  #handleCommit(
    ops: CommitOp[],
    readSet: URI[],
    _source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const clientSeq = ++this.#clientSeq;

    const { promise, resolve } = Promise.withResolvers<
      Result<Unit, StorageTransactionRejected>
    >();
    this.#pendingCommits.set(clientSeq, resolve);
    this.#track(promise);

    const msg: ClientCommit = {
      type: "commit",
      clientSeq,
      serverSeq: this.#serverSeq,
      readSet,
      ops,
      signature: "",
    };
    this.#send(msg);
    return promise;
  }
}

// ---------------------------------------------------------------------------
// StitchStorageProvider
// ---------------------------------------------------------------------------

export interface StitchStorageProviderOptions {
  space: MemorySpace;
  address: URL;
  subscription: IStorageSubscription;
}

/**
 * IStorageProviderWithReplica backed by the stitch WebSocket sync protocol.
 */
export class StitchStorageProvider implements IStorageProviderWithReplica {
  readonly replica: StitchReplica;
  readonly #connection: StitchConnection;

  constructor({ space, address, subscription }: StitchStorageProviderOptions) {
    this.replica = new StitchReplica(space, subscription);
    this.#connection = new StitchConnection({
      address,
      space,
      replica: this.replica,
    });
  }

  sync(uri: URI, selector?: SchemaPathSelector): Promise<Result<Unit, Error>> {
    return this.#connection.subscribe(uri, selector);
  }

  synced(): Promise<void> {
    return this.#connection.synced();
  }

  destroy(): Promise<void> {
    this.#connection.destroy();
    return Promise.resolve();
  }

  getReplica(): string | undefined {
    return this.replica.did();
  }
}
