import { type CellImpl } from "./cell.js";
import { type EntityId } from "./cell-map.js";

interface Storage {
  loadCell(cell: CellImpl<any>): Promise<void>;
  persistCell(cell: CellImpl<any>): Promise<void>;
}

class StorageImpl implements Storage {
  constructor(private storageProvider: StorageProvider) {}

  private loadedCells = new Set<string>();
  private loadingCells = new Map<string, Promise<void>>();

  async loadCell(cell: CellImpl<any>): Promise<void> {
    if (!cell.entityId) throw new Error("Cell has no entity ID");

    const entityId = JSON.stringify(cell.entityId);

    // If the cell is already loaded, return immediately
    if (this.loadedCells.has(entityId)) return;

    // If loading is in progress, wait for it to finish
    if (this.loadingCells.has(entityId)) return this.loadingCells.get(entityId);

    // Start loading the cell
    const loadingPromise = this._loadCell(cell);
    this.loadingCells.set(entityId, loadingPromise);

    try {
      await loadingPromise;
      this.loadedCells.add(entityId);
    } finally {
      // Remove the loading promise when done (success or failure)
      this.loadingCells.delete(entityId);
    }
  }

  private async _loadCell(cell: CellImpl<any>): Promise<void> {
    const storedValue = await this.storageProvider.read(cell.entityId!);

    if (storedValue !== undefined) {
      cell.send(storedValue);
    } else {
      // If the cell doesn't exist in storage, persist the current value
      await this.persistCell(cell);
    }

    this.subscribeToChanges(cell);
  }

  async persistCell(cell: CellImpl<any>): Promise<void> {
    if (!cell.entityId) throw new Error("Cell has no entity ID");

    await this.storageProvider.update(cell.entityId, cell.get());
  }

  private subscribeToChanges(cell: CellImpl<any>): void {
    cell.updates(async (value) => {
      await this.storageProvider.update(cell.entityId!, value);
    });

    // Subscribe to storage updates
    (async () => {
      for await (const value of this.storageProvider.subscribe(
        cell.entityId!
      )) {
        cell.send(value);
      }
    })();
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
  update<T = any>(entityId: EntityId, value: T): Promise<void>;
  read<T = any>(entityId: EntityId): Promise<T>;
  subscribe<T = any>(entityId: EntityId): AsyncGenerator<T>;
}

abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<string, Set<(value: any) => void>>();

  abstract update(entityId: EntityId, value: any): Promise<void>;
  abstract read(entityId: EntityId): Promise<any>;

  async *subscribe<T = any>(entityId: EntityId): AsyncGenerator<T> {
    const key = JSON.stringify(entityId);
    const queue: any[] = [];
    let resolve: ((value: any) => void) | null = null;
    const listener = (value: any) => {
      if (resolve) {
        resolve(value);
        resolve = null;
      } else {
        queue.push(value);
      }
    };

    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    const listeners = this.subscribers.get(key)!;
    listeners.add(listener);

    return {
      async next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false };
        }
        return new Promise((r) => (resolve = r));
      },
      async return(): Promise<IteratorResult<T>> {
        listeners.delete(listener);
        if (listeners.size === 0) this.subscribers.delete(key);
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  protected notifySubscribers(key: string, value: any): void {
    const listeners = this.subscribers.get(key);
    if (listeners) {
      for (const listener of listeners) {
        listener(value);
      }
    }
  }
}

class InMemoryStorageProvider extends BaseStorageProvider {
  private storage = new Map<string, any>();

  async update(entityId: EntityId, value: any): Promise<void> {
    const key = JSON.stringify(entityId);
    this.storage.set(key, value);
    this.notifySubscribers(key, value);
  }

  async read(entityId: EntityId): Promise<any> {
    return this.storage.get(JSON.stringify(entityId));
  }
}

// Updated LocalStorageProvider
class LocalStorageProvider extends BaseStorageProvider {
  private prefix: string;

  constructor(prefix: string = "common_storage_") {
    if (typeof window === "undefined" || !window.localStorage)
      throw new Error("LocalStorageProvider is not supported in the browser");
    super();
    this.prefix = prefix;
    window.addEventListener("storage", this.handleStorageEvent);
  }

  private getKey(entityId: EntityId): string {
    return this.prefix + JSON.stringify(entityId);
  }

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key && event.key.startsWith(this.prefix)) {
      const key = event.key.slice(this.prefix.length);
      const value = event.newValue ? JSON.parse(event.newValue) : undefined;
      this.notifySubscribers(key, value);
    }
  };

  async update(entityId: EntityId, value: any): Promise<void> {
    const key = this.getKey(entityId);
    localStorage.setItem(key, JSON.stringify(value));
    this.notifySubscribers(JSON.stringify(entityId), value);
  }

  async read(entityId: EntityId): Promise<any> {
    const key = this.getKey(entityId);
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : undefined;
  }

  destroy() {
    window.removeEventListener("storage", this.handleStorageEvent);
  }
}

export const storage = createStorage("memory");
