import type { DID, StorageClientOptions } from "./types.ts";

export class StorageClient {
  #baseUrl: string;
  #token?: string | (() => Promise<string>);
  #spaces = new Map<string, import("./connection.ts").SpaceConnection>();
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
      sc.onServerDoc = ({ docId, epoch, heads, json }) => {
        store.applyServerDoc({ space: key, docId, epoch, heads, json });
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
    return new ClientTransaction();
  }
}

// Intentionally minimal public surface for initial scaffold; detailed exports
// will be added as implementation lands.

// Further API (get) will be added incrementally.

const clientStoreMap = new WeakMap<StorageClient, import("./store.ts").ClientStore>();
