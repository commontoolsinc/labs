import type { DID, StorageClientOptions } from "./types.ts";
import { Scheduler } from "./scheduler.ts";

export class StorageClient {
  #baseUrl: string;
  #token?: string | (() => Promise<string>);
  #spaces = new Map<string, import("./connection.ts").SpaceConnection>();
  #scheduler = new Scheduler();
  constructor(opts: StorageClientOptions = {}) {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    this.#baseUrl = opts.baseUrl ?? (loc?.origin ?? "http://localhost:8002");
    this.#token = opts.token;
  }

  async connect(_space: DID | string): Promise<void> {
    const { SpaceConnection } = await import("./connection.ts");
    const key = String(_space);
    let sc = this.#spaces.get(key);
    if (!sc) {
      sc = new SpaceConnection(key, {
        baseUrl: this.#baseUrl,
        token: this.#token,
      });
      // Bind store updater lazily on first creation
      const { ClientStore } = await import("./store.ts");
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
      };
      this.#spaces.set(key, sc);
    }
    return sc.open();
  }

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

  async synced(space?: DID | string): Promise<void> {
    if (space) {
      const sc = await this.spaceConn(space);
      return sc.synced();
    }
    await Promise.all(
      Array.from(this.#spaces.values()).map((sc) => sc.synced()),
    );
  }

  async newTransaction() {
    const { ClientTransaction } = await import("./tx.ts");
    // Ensure a store exists for overlays even if connect() hasn't been called yet
    const { ClientStore } = await import("./store.ts");
    const existing = clientStoreMap.get(this);
    const store = existing ?? new ClientStore();
    if (!existing) clientStoreMap.set(this, store);

    const commitAdapter = async (
      space: string,
      req: Parameters<import("./connection.ts").SpaceConnection["submitTx"]>[0],
    ) => {
      const sc = await this.spaceConn(space);
      return await sc.submitTx(req as any);
    };
    const baselineProvider = async (space: string, docId: string) => {
      const sc = await this.spaceConn(space);
      const d = await sc.getAutomergeDoc(docId);
      return d as any;
    };
    const overlay = {
      applyPending: (space: string, docId: string, id: string, json: unknown) =>
        store.applyPending({ space, docId, id, json }),
      clearPending: (space: string, docId: string, id: string) =>
        store.clearPending({ space, docId, id }),
    } as const;
    return new ClientTransaction(commitAdapter, baselineProvider, overlay);
  }

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

  onChange(
    cb: (e: import("./scheduler.ts").SchedulerEvent) => void,
  ): () => void {
    return this.#scheduler.on(cb);
  }

  async submitTx(
    space: DID | string,
    req: Parameters<import("./connection.ts").SpaceConnection["submitTx"]>[0],
  ): Promise<import("../types.ts").TxReceipt> {
    const sc = await this.spaceConn(space);
    return sc.submitTx(req as any);
  }

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
