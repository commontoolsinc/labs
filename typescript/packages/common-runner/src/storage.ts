import { type CellImpl } from "./cell.js";
import { type EntityId } from "./cell-map.js";

// Define the StorageProvider interface
export interface StorageProvider {
  update(entityId: EntityId, value: any): Promise<void>;
  read(entityId: EntityId): Promise<any>;
  subscribe(entityId: EntityId): AsyncGenerator<any, void, unknown>;
}

// Implement an in-memory StorageProvider
class InMemoryStorageProvider implements StorageProvider {
  private storage = new Map<string, any>();
  private subscribers = new Map<string, Set<(value: any) => void>>();

  async update(entityId: EntityId, value: any): Promise<void> {
    const key = JSON.stringify(entityId);
    this.storage.set(key, value);
    this.notifySubscribers(key, value);
  }

  async read(entityId: EntityId): Promise<any> {
    return this.storage.get(JSON.stringify(entityId));
  }

  async *subscribe(entityId: EntityId): AsyncGenerator<any, void, unknown> {
    const key = JSON.stringify(entityId);
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    const listeners = this.subscribers.get(key)!;
    let resolve: ((value: any) => void) | null = null;
    const listener = (value: any) => {
      if (resolve) {
        resolve(value);
        resolve = null;
      }
    };
    listeners.add(listener);

    try {
      while (true) {
        yield await new Promise<any>((r) => {
          resolve = r;
        });
      }
    } finally {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.subscribers.delete(key);
      }
    }
  }

  private notifySubscribers(key: string, value: any): void {
    const listeners = this.subscribers.get(key);
    if (listeners) {
      for (const listener of listeners) {
        listener(value);
      }
    }
  }
}

// Create an instance of the storage provider
const storageProvider = new InMemoryStorageProvider();

/**
 * Load a cell from storage.
 *
 * @param entityId - The entity ID of the cell to load.
 * @param cell - The cell to load into.
 * @returns A promise that resolves when the cell is loaded.
 */
export async function loadCell(
  entityId: EntityId,
  cell: CellImpl<any>
): Promise<void> {
  const storedValue = await storageProvider.read(entityId);

  if (storedValue !== undefined) {
    cell.send(storedValue);
  } else {
    // If the cell doesn't exist in storage, persist the current value
    await persistCell(entityId, cell);
  }

  // Subscribe to changes
  subscribeToChanges(entityId, cell);
}

/**
 * Persist a cell to storage.
 *
 * @param entityId - The entity ID of the cell to persist.
 * @param cell - The cell to persist.
 */
export async function persistCell(
  entityId: EntityId,
  cell: CellImpl<any>
): Promise<void> {
  await storageProvider.update(entityId, cell.get());
}

/**
 * Subscribe to cell updates and persist changes.
 *
 * @param entityId - The entity ID of the cell.
 * @param cell - The cell to subscribe to.
 */
function subscribeToChanges(entityId: EntityId, cell: CellImpl<any>): void {
  cell.updates(async (value) => {
    await storageProvider.update(entityId, value);
  });

  // Subscribe to storage updates
  (async () => {
    for await (const value of storageProvider.subscribe(entityId)) {
      cell.send(value);
    }
  })();
}
