import { Identity } from "./identity.js";
import { once } from "./utils.js";

const DB_NAME = "common-key-store";
const DEFAULT_STORE_NAME = "key-store";
const DB_VERSION = 1;

// An abstraction around storing key materials in IndexedDb.
export class KeyStore {
  static DEFAULT_STORE_NAME = DEFAULT_STORE_NAME;
  private db: DB;
  private storeName: string;

  constructor(db: DB, storeName: string) {
    this.db = db;
    this.storeName = storeName;
  }

  // Get the `name` keypair.
  async get(name: string): Promise<Identity | undefined> {
    let result = await this.db.get(this.storeName, name);
    if (result) {
      return await Identity.deserialize(result);
    }
    return result;
  }
  
  // Set the `name` keypair with `value`.
  async set(name: string, value: Identity): Promise<undefined> {
    await this.db.set(this.storeName, name, value.serialize());
  }

  // Clear the key store's table.
  async clear(): Promise<any> {
    return await this.db.clear(this.storeName);
  }

  // Opens a new instance of `KeyStore`.
  // If no `name` provided, `KeyStore.DEFAULT_STORE_NAME` is used. 
  static async open(name = KeyStore.DEFAULT_STORE_NAME): Promise<KeyStore> {
    let db = await DB.open(DB_NAME, DB_VERSION, (e: IDBVersionChangeEvent) => {
      const { newVersion, oldVersion: _ } = e;
      if (newVersion !== DB_VERSION) { throw new Error("common-identity: Invalid DB version."); }
      if (!e.target) { throw new Error("common-identity: No target on change event."); }
      let db: IDBDatabase = (e.target as IDBRequest).result; 
      db.createObjectStore(name);
    });
    return new KeyStore(db, name);
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