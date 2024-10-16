import { type CellImpl, isCell, cell } from "./cell.js";
import { type EntityId } from "./cell-map.js";
import { type Cancel, type AddCancel, useCancelGroup } from "./cancel.js";

export interface Storage {
  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * This will currently also follow all encountered cell references and load
   * these cells as well.
   *
   * This works also for cells that haven't been persisted yet. In that case,
   * it'll write the current value into storage. In most cases, this is
   * preferrable to `persist()`, which will always overwrite the existing value.
   *
   * @param cell - Cell to load into, or entity ID as EntityId or string.
   * @returns Promise that resolves to the cell when it is loaded.
   * @throws Will throw if called on a cell without an entity ID.
   */
  loadCell<T = any>(
    cell: CellImpl<T> | EntityId | string
  ): Promise<CellImpl<T>>;

  /**
   * Persist cell. Most of the time you want to use `load()` instead.
   *
   * Writes current state to storage and subscribes to new changes.
   *
   * Like `load()`, it will follow cell references and persist them (using
   * `load()` if they already have an id, otherwise assign an id causal to this
   * one and call `persist` instead).
   *
   * Only call on new cells. Has to be called after `generateEntityId`.
   *
   * Use `load()` when restoring from storage, including when the id was
   * generated in a causal way, so that a previous run would have generated the
   * same id, but might already progressed further (i.e. the state in storage is
   * more current than the one currently being spun up, such as when rehydrating
   * a previous run).
   *
   * @throws Will throw if called on a cell without an entity ID.
   */
  persistCell<T = any>(cell: CellImpl<T>): Promise<void>;

  /**
   * Clear all stored data.
   * @returns Promise that resolves when the operation is complete.
   */
  clear(): Promise<void>;
}

class StorageImpl implements Storage {
  constructor(private storageProvider: StorageProvider) {
    const [cancel, addCancel] = useCancelGroup();
    this.cancel = cancel;
    this.addCancel = addCancel;
  }

  private loadedCells = new Map<string, CellImpl<any>>();
  private loadingCells = new Map<string, Promise<void>>();

  private cancel: Cancel;
  private addCancel: AddCancel;

  async loadCell<T>(
    subject: CellImpl<T> | EntityId | string
  ): Promise<CellImpl<T>> {
    let entityId: string;
    let entityCell: CellImpl<T>;

    if (isCell(subject)) {
      entityCell = subject;
      if (!entityCell.entityId) throw new Error("Cell has no entity ID");
      entityId = JSON.stringify(entityCell.entityId);
    } else if (typeof subject === "string") {
      entityCell = cell<T>();
      entityCell.entityId = JSON.parse(subject);
      entityId = subject;
    } /* assumed to be EntityId */ else {
      entityCell = cell<T>();
      entityCell.entityId = subject;
      entityId = JSON.stringify(subject);
    }

    // If the cell is already loaded, return immediately
    if (this.loadedCells.has(entityId)) return this.loadedCells.get(entityId)!;

    // If loading is in progress, wait for it to finish
    if (this.loadingCells.has(entityId)) {
      await this.loadingCells.get(entityId);
      return this.loadedCells.get(entityId)!;
    }

    // Start loading the cell
    const loadingPromise = this._loadCell(entityCell);
    this.loadingCells.set(entityId, loadingPromise);

    await loadingPromise.then(() => this.loadingCells.delete(entityId));

    return entityCell;
  }

  private async _loadCell(cell: CellImpl<any>): Promise<void> {
    const storedValue = await this.storageProvider.get(cell.entityId!);

    if (storedValue !== undefined) {
      this.subscribeToChanges(cell);
      cell.send(storedValue);
    } else {
      // If the cell doesn't exist in storage, persist the current value
      await this.persistCell(cell);
    }

    this.loadedCells.set(JSON.stringify(cell.entityId), cell);
  }

  async persistCell(cell: CellImpl<any>): Promise<void> {
    if (!cell.entityId) throw new Error("Cell has no entity ID");

    this.subscribeToChanges(cell);

    await this.storageProvider.send(cell.entityId, cell.get());
  }

  async clear(): Promise<void> {
    await this.storageProvider.clear();
    this.loadedCells.clear();
    this.loadingCells.clear();
    this.cancel();
  }

  private subscribeToChanges(cell: CellImpl<any>): void {
    // Send updates to storage
    this.addCancel(
      cell.updates((value) => {
        this.storageProvider.send(cell.entityId!, value);
      })
    );

    // Subscribe to storage updates
    this.addCancel(
      this.storageProvider.sink(cell.entityId!, (value) => {
        cell.send(value);
      })
    );
  }
}

export function createStorage(type: "local" | "memory"): Storage {
  let storageProvider: StorageProvider;

  if (type === "local") {
    storageProvider = new LocalStorageProvider();
  } else if (type === "memory") {
    storageProvider = new InMemoryStorageProvider();
  } else {
    throw new Error("Invalid storage type");
  }

  return new StorageImpl(storageProvider);
}

interface StorageProvider {
  send<T = any>(entityId: EntityId, value: T): Promise<void>;
  get<T = any>(entityId: EntityId): Promise<T>;
  sink<T = any>(entityId: EntityId, callback: (value: T) => void): Cancel;
  clear(): Promise<void>;
}

abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<string, Set<(value: any) => void>>();

  abstract send(entityId: EntityId, value: any): Promise<void>;
  abstract get(entityId: EntityId): Promise<any>;

  sink<T = any>(entityId: EntityId, callback: (value: T) => void): Cancel {
    const key = JSON.stringify(entityId);

    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set());
    const listeners = this.subscribers.get(key)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(key);
    };
  }

  protected notifySubscribers(key: string, value: any): void {
    const listeners = this.subscribers.get(key);
    if (listeners) for (const listener of listeners) listener(value);
  }

  abstract clear(): Promise<void>;
}

/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const inMemoryStorage = new Map<string, any>();
const inMemoryStorageSubscribers = new Set<(key: string, value: any) => void>();
class InMemoryStorageProvider extends BaseStorageProvider {
  constructor() {
    super();
    inMemoryStorageSubscribers.add(this.handleStorageUpdate.bind(this));
  }

  private handleStorageUpdate(key: string, value: any) {
    this.notifySubscribers(key, value);
  }

  async send(entityId: EntityId, value: any): Promise<void> {
    const key = JSON.stringify(entityId);
    inMemoryStorage.set(key, value);
    inMemoryStorageSubscribers.forEach((listener) => listener(key, value));
    this.notifySubscribers(key, value);
  }

  async get(entityId: EntityId): Promise<any> {
    return inMemoryStorage.get(JSON.stringify(entityId));
  }

  async clear(): Promise<void> {
    inMemoryStorage.clear();
    this.subscribers.clear();
  }

  destroy() {
    inMemoryStorageSubscribers.delete(this.handleStorageUpdate);
  }
}

/**
 * Local storage provider for browser.
 */
class LocalStorageProvider extends BaseStorageProvider {
  private prefix: string;

  constructor(prefix: string = "common_storage_") {
    if (typeof window === "undefined" || !window.localStorage)
      throw new Error("LocalStorageProvider is not supported in the browser");
    super();
    this.prefix = prefix;
    window.addEventListener("storage", this.handleStorageEvent.bind(this));
  }

  private getKey(entityId: EntityId): string {
    return this.prefix + JSON.stringify(entityId);
  }

  private handleStorageEvent = (event: StorageEvent) => {
    console.log("storage event", event);
    if (event.key && event.key.startsWith(this.prefix)) {
      const key = event.key.slice(this.prefix.length);
      const value = event.newValue ? JSON.parse(event.newValue) : undefined;
      this.notifySubscribers(key, value);
    }
  };

  async send(entityId: EntityId, value: any): Promise<void> {
    const key = this.getKey(entityId);
    localStorage.setItem(key, JSON.stringify(value));
  }

  async get(entityId: EntityId): Promise<any> {
    const key = this.getKey(entityId);
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : undefined;
  }

  async clear(): Promise<void> {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(this.prefix)) {
        localStorage.removeItem(key);
      }
    }
    this.subscribers.clear();
  }

  destroy() {
    window.removeEventListener("storage", this.handleStorageEvent);
  }
}
