import { Identity } from "./identity.ts";
import { KeyPairRaw } from "./interface.ts";
import { once } from "./utils.ts";

const DEFAULT_DB_NAME = "common-key-store";
const DEFAULT_STORE_NAME = "key-store";
const DB_VERSION = 1;

// An abstraction around storing key materials in IndexedDb.
export class KeyStore {
  static DEFAULT_DB_NAME = DEFAULT_DB_NAME;
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  // Get the `name` keypair.
  async get(name: string): Promise<Identity | void> {
    const result = await this.db.get(name);
    if (result) {
      return Identity.deserialize(result);
    }
    return result;
  }

  // Set the `name` keypair with `value`.
  async set(name: string, value: Identity): Promise<undefined> {
    await this.db.set(name, value.serialize());
  }

  // Clear the key store's table.
  clear(): Promise<void> {
    return this.db.clear();
  }

  // Opens a new instance of `KeyStore`.
  // If no `name` provided, `KeyStore.DEFAULT_DB_NAME` is used.
  static async open(name = KeyStore.DEFAULT_DB_NAME): Promise<KeyStore> {
    const db = await DB.open(name, DB_VERSION, (event: Event) => {
      const e = event as IDBVersionChangeEvent;
      const { newVersion, oldVersion: _ } = e;
      if (newVersion !== DB_VERSION) {
        throw new Error("common-identity: Invalid DB version.");
      }
      if (!e.target) {
        throw new Error("common-identity: No target on change event.");
      }
      const db: IDBDatabase = (e.target as IDBRequest).result;
      db.createObjectStore(DEFAULT_STORE_NAME);
    });
    return new KeyStore(db);
  }
}

class DB {
  private db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.db = db;
  }

  get(key: string): Promise<KeyPairRaw | void> {
    const store = this.getStore(DEFAULT_STORE_NAME, "readonly");
    return asyncWrap(store.get(key));
  }

  set(key: string, value: unknown): Promise<void> {
    const store = this.getStore(DEFAULT_STORE_NAME, "readwrite");
    return asyncWrap(store.put(value, key)).then(() => undefined);
  }

  async clear() {
    const store = this.getStore(DEFAULT_STORE_NAME, "readwrite");
    return await asyncWrap(store.clear());
  }

  static async open(
    dbName: string,
    dbVersion: number,
    onUpgrade: (e: Event) => void,
  ) {
    const req = globalThis.indexedDB.open(dbName, dbVersion);
    once(req, "upgradeneeded", onUpgrade);
    once(req, "blocked", (e) => {
      console.log("KeyStore: Blocked");
    });
    const db = await asyncWrap(req);
    once(db, "versionchange", (event) => {
      const e = event as IDBVersionChangeEvent;
      console.log("KeyStore: VersionChange", e.oldVersion, e.newVersion);
    });
    return new DB(db);
  }

  private getStore(
    storeName: string,
    mode: "readonly" | "readwrite",
  ): IDBObjectStore {
    const tx = this.db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }
}

function asyncWrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    once(request, "success", (_e: Event): unknown => resolve(request.result));
    once(request, "error", (_e: Event): unknown => reject(request.error));
  });
}
