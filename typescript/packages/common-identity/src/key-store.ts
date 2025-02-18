import { once } from "./utils.js";

const DB_NAME = "key-store";
const STORE_NAME = "key-store";
const ROOT_KEY = "root-key";
const DB_VERSION = 1;

// An abstraction around storing key materials in IndexedDb.
// For now, we use a hardcoded, well-known database, store, and key-name,
// such that there's a single location to determine if a root key is
// available.
export class KeyStore {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  // Get the `RootKey` keypair at the globally-known key space. 
  async get(): Promise<CryptoKeyPair | undefined> {
    return await this.db.get(STORE_NAME, ROOT_KEY);
  }
  
  // Set the global `RootKey` keypair at the globally-known key space. 
  async set(value: CryptoKeyPair): Promise<any> {
    return await this.db.set(STORE_NAME, ROOT_KEY, value);
  }

  // Clear the key store's table.
  async clear(): Promise<any> {
    return await this.db.clear(STORE_NAME);
  }

  // Create a new instance of `KeyStore`.
  static async open(): Promise<KeyStore> {
    let db = await DB.open(DB_NAME, DB_VERSION, (e: IDBVersionChangeEvent) => {
      const { newVersion, oldVersion: _ } = e;
      if (newVersion !== DB_VERSION) { throw new Error("common-identity: Invalid DB version."); }
      if (!e.target) { throw new Error("common-identity: No target on change event."); }
      let db: IDBDatabase = (e.target as IDBRequest).result; 
      db.createObjectStore(STORE_NAME);
    });
    return new KeyStore(db);
  }

}

class DB {
  private db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async get(storeName: string, key: string) {
    let store = this.getStore(storeName, "readonly");
    return await asyncWrap(store.get(key));
  }
  
  async set(storeName: string, key: string, value: any) {
    let store = this.getStore(storeName, "readwrite");
    return await asyncWrap(store.put(value, key));
  }
  
  async clear(storeName: string) {
    let store = this.getStore(storeName, "readwrite");
    return await asyncWrap(store.clear());
  }

  static async open(dbName: string, dbVersion: number, onUpgrade: (e: IDBVersionChangeEvent) => any) {
    let req = window.indexedDB.open(dbName, dbVersion);
    once(req, "upgradeneeded", onUpgrade);
    return new DB(await asyncWrap(req));
  }
  
  private getStore(storeName: string,mode: "readonly" | "readwrite"): IDBObjectStore {
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