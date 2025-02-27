import { Identity } from "./identity.js";
import { once } from "./utils.js";

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
  async get(name: string): Promise<Identity | undefined> {
    let result = await this.db.get(name);
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
  async clear(): Promise<any> {
    return this.db.clear();
  }

  // Opens a new instance of `KeyStore`.
  // If no `name` provided, `KeyStore.DEFAULT_DB_NAME` is used. 
  static async open(name = KeyStore.DEFAULT_DB_NAME): Promise<KeyStore> {
    let db = await DB.open(name, DB_VERSION, (e: IDBVersionChangeEvent) => {
      const { newVersion, oldVersion: _ } = e;
      if (newVersion !== DB_VERSION) { throw new Error("common-identity: Invalid DB version."); }
      if (!e.target) { throw new Error("common-identity: No target on change event."); }
      let db: IDBDatabase = (e.target as IDBRequest).result; 
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

  async get(key: string) {
    let store = this.getStore(DEFAULT_STORE_NAME, "readonly");
    return asyncWrap(store.get(key));
  }
  
  async set(key: string, value: any) {
    let store = this.getStore(DEFAULT_STORE_NAME, "readwrite");
    return asyncWrap(store.put(value, key));
  }
  
  async clear() {
    let store = this.getStore(DEFAULT_STORE_NAME, "readwrite");
    return await asyncWrap(store.clear());
  }

  static async open(dbName: string, dbVersion: number, onUpgrade: (e: IDBVersionChangeEvent) => any) {
    let req = window.indexedDB.open(dbName, dbVersion);
    once(req, "upgradeneeded", onUpgrade);
    return new DB(await asyncWrap(req));
  }
  
  private getStore(storeName: string, mode: "readonly" | "readwrite"): IDBObjectStore {
    let tx = this.db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }
}

function asyncWrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    once(request, "success", (_e: Event): any => resolve(request.result));
    once(request, "error", (_e: Event): any => reject(request.error));
  });
}