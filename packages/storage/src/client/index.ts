import type { DID, StorageClientOptions } from "./types.ts";
import { SpaceConnection } from "./connection.ts";
import { ClientStore } from "./store.ts";
import { Scheduler } from "./scheduler.ts";
import { ClientTransaction } from "./tx.ts";

/**
 * High-level client for the storage WS v2 service.
 *
 * Responsibilities:
 * - Manage per-space WebSocket connections
 * - Maintain a local composed view (server + optimistic overlays)
 * - Provide a simple transaction API for optimistic commits
 * - Emit change events for consumers (e.g., UI)
 *
 * Authentication: `token` in StorageClientOptions is reserved for future WS
 * authentication. WebSocket constructors in browsers do not support custom
 * headers; HTTP route auth is enforced separately. WS auth will be added once a
 * compatible mechanism is defined.
 */
export class StorageClient {
  #baseUrl: string;
  #token?: string | (() => Promise<string>);
  #spaces = new Map<string, import("./connection.ts").SpaceConnection>();
  #scheduler = new Scheduler();
  #inflightCommits = new Set<Promise<unknown>>();
  #openTxs = new Set<import("./tx.ts").ClientTransaction>();
  constructor(opts: StorageClientOptions = {}) {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    this.#baseUrl = opts.baseUrl ?? (loc?.origin ?? "http://localhost:8002");
    this.#token = opts.token;
  }

  /** Open or reuse a connection to a space. */
  connect(_space: DID | string): Promise<void> {
    const key = String(_space);
    let sc = this.#spaces.get(key);
    if (!sc) {
      sc = new SpaceConnection(key, {
        baseUrl: this.#baseUrl,
        token: this.#token,
      });
      // Bind store updater lazily on first creation
      const store = clientStoreMap.get(this) ?? new ClientStore();
      clientStoreMap.set(this, store);
      sc.onServerDocConfirm = (docId: string) => {
        store.clearAllPendingForDoc(key, docId);
      };
      sc.onServerDoc = ({ docId, epoch, heads, json }) => {
        const before = store.readView(key, docId).json;
        store.applyServerDoc({ space: key, docId, epoch, heads, json });
        const after = store.readView(key, docId).json;
        this.#scheduler.emit({ space: key, docId, path: [], before, after });
        // Conservative invalidation: notify all open transactions that read this doc
        for (const tx of this.#openTxs) {
          try {
            tx.externalDocChanged(key, docId);
          } catch {
            // ignore
          }
        }
      };
      this.#spaces.set(key, sc);
    }
    return sc.open();
  }

  /** Disconnect from a space and close its WebSocket. */
  disconnect(_space: DID | string): Promise<void> {
    const key = String(_space);
    const sc = this.#spaces.get(key);
    if (!sc) return Promise.resolve();
    this.#spaces.delete(key);
    return sc.close();
  }

  private async spaceConn(
    space: DID | string,
  ): Promise<import("./connection.ts").SpaceConnection> {
    await this.connect(space);
    return this.#spaces.get(String(space))!;
  }

  /** Subscribe to a document root/path and receive backfill + updates. */
  async subscribe(
    space: DID | string,
    opts: {
      consumerId: string;
      query: { docId: string; path?: string[]; schema?: unknown };
    },
  ): Promise<() => void> {
    const sc = await this.spaceConn(space);
    return sc.subscribe(opts);
  }

  /** Wait until initial subscriptions (and in-flight commits) settle. */
  async synced(space?: DID | string): Promise<void> {
    if (space) {
      const sc = await this.spaceConn(space);
      await sc.synced();
      if (this.#inflightCommits.size > 0) {
        await Promise.allSettled(Array.from(this.#inflightCommits));
      }
      return;
    }
    await Promise.all(
      Array.from(this.#spaces.values()).map((sc) => sc.synced()),
    );
    if (this.#inflightCommits.size > 0) {
      await Promise.allSettled(Array.from(this.#inflightCommits));
    }
  }

  /** Create a new client-side transaction with optimistic overlay support. */
  newTransaction() {
    const existing = clientStoreMap.get(this);
    const store = existing ?? new ClientStore();
    if (!existing) clientStoreMap.set(this, store);

    const commitAdapter = async (
      space: string,
      req: Parameters<import("./connection.ts").SpaceConnection["submitTx"]>[0],
    ) => {
      const sc = await this.spaceConn(space);
      const p = sc.submitTx(req as any);
      this.#inflightCommits.add(p);
      try {
        return await p;
      } finally {
        this.#inflightCommits.delete(p);
      }
    };
    const baselineProvider = async (space: string, docId: string) => {
      const sc = await this.spaceConn(space);
      const d = sc.getAutomergeDoc(docId);
      return d as any;
    };
    const overlay = {
      applyPending: (
        space: string,
        docId: string,
        id: string,
        json: unknown,
        baseHeads?: string[],
      ) => store.applyPending({ space, docId, id, json, baseHeads }),
      clearPending: (space: string, docId: string, id: string) =>
        store.clearPending({ space, docId, id }),
      promotePendingToServer: (
        space: string,
        docId: string,
        id: string,
        epoch?: number,
        heads?: string[],
      ) => store.promotePendingToServer({ space, docId, id, epoch, heads }),
    } as const;
    const hooks = {
      onOpen: (tx: import("./tx.ts").ClientTransaction) => {
        this.#openTxs.add(tx);
      },
      onClose: (tx: import("./tx.ts").ClientTransaction) => {
        this.#openTxs.delete(tx);
      },
      onCommitted: (
        tx: import("./tx.ts").ClientTransaction,
        info: { space: string; status: "ok" | "conflict" | "rejected" },
      ) => {
        if (info.status !== "ok") {
          // Cascade rejection: any open tx that read a doc written by this tx becomes invalid
          const writtenDocs = tx.getWriteDocs();
          for (const other of this.#openTxs) {
            if (other === tx) continue;
            try {
              other.dependencyRejected(info.space, writtenDocs);
            } catch {
              // ignore
            }
          }
        }
      },
    } as const;
    return new ClientTransaction(
      commitAdapter,
      baselineProvider,
      overlay,
      hooks,
    );
  }

  /** One-shot get: backfill for the query and return composed view. */
  async get(
    space: DID | string,
    opts: {
      consumerId: string;
      query: { docId: string; path?: string[]; schema?: unknown };
    },
  ): Promise<{ json: unknown; version: { epoch: number } }> {
    const sc = await this.spaceConn(space);
    await sc.get(opts);
    const store = clientStoreMap.get(this)!;
    const v = store.readView(String(space), opts.query.docId);
    return v;
  }

  /** Register a change listener; returns an unsubscribe function. */
  onChange(
    cb: (e: import("./scheduler.ts").SchedulerEvent) => void,
  ): () => void {
    return this.#scheduler.on(cb);
  }

  /** Submit a transaction directly (without optimistic overlay handling). */
  async submitTx(
    space: DID | string,
    req: Parameters<import("./connection.ts").SpaceConnection["submitTx"]>[0],
  ): Promise<import("../types.ts").TxReceipt> {
    const sc = await this.spaceConn(space);
    return sc.submitTx(req as any);
  }

  /** Read the composed view (server + pending overlay) for a document. */
  readView(
    space: DID | string,
    docId: string,
  ): { json: unknown; version: { epoch: number } } {
    const store = clientStoreMap.get(this);
    if (!store) return { json: undefined, version: { epoch: -1 } };
    return store.readView(String(space), docId);
  }
}

// Intentionally minimal public surface for initial scaffold; detailed exports
// will be added as implementation lands.

// Further API (get) will be added incrementally.

const clientStoreMap = new WeakMap<
  StorageClient,
  import("./store.ts").ClientStore
>();
