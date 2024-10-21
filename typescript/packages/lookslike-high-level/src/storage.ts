import {
  type CellImpl,
  isCell,
  type CellReference,
  isCellReference,
  type EntityId,
  type Cancel,
  type AddCancel,
  useCancelGroup,
  getCellByEntityId,
} from "@commontools/common-runner";

export interface Storage {
  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * This will currently also follow all encountered cell references and load
   * these cells as well.
   *
   * This works also for cells that haven't been persisted yet. In that case,
   * it'll write the current value into storage.
   *
   * @param cell - Cell to load into, or entity ID as EntityId or string.
   * @returns Promise that resolves to the cell when it is loaded.
   * @throws Will throw if called on a cell without an entity ID.
   */
  syncCell<T = any>(
    cell: CellImpl<T> | EntityId | string
  ): Promise<CellImpl<T>>;

  /**
   * Clear all stored data.
   * @returns Promise that resolves when the operation is complete.
   */
  destroy(): Promise<void>;
}

class StorageImpl implements Storage {
  constructor(private storageProvider: StorageProvider) {
    const [cancel, addCancel] = useCancelGroup();
    this.cancel = cancel;
    this.addCancel = addCancel;
  }

  private cellsById = new Map<string, CellImpl<any>>();
  private loadingCells = new Map<CellImpl<any>, Promise<CellImpl<any>>>();
  private writeDependentCells = new Map<CellImpl<any>, Set<CellImpl<any>>>();
  private readDependentCells = new Map<CellImpl<any>, Set<CellImpl<any>>>();

  private cancel: Cancel;
  private addCancel: AddCancel;

  syncCell<T>(subject: CellImpl<T> | EntityId | string): Promise<CellImpl<T>> {
    const entityCell = this._ensureIsSynced(subject);

    // Is loading pending?
    const loadingPromise = this.loadingCells.get(entityCell);
    return loadingPromise ? loadingPromise : Promise.resolve(entityCell);
  }

  async destroy(): Promise<void> {
    await this.storageProvider.destroy();
    this.cellsById.clear();
    this.loadingCells.clear();
    this.cancel();
  }

  private _ensureIsSynced<T>(
    subject: CellImpl<T> | EntityId | string
  ): CellImpl<T> {
    const entityCell = StorageImpl.fromIdToCell<T>(subject);
    const entityId = JSON.stringify(entityCell.entityId);

    // If the cell is already loaded or loading, return immediately. Note this
    // returns the original cell, even if another one was provided as argument.
    if (this.cellsById.has(entityId)) return this.cellsById.get(entityId)!;

    // Important that we set this _before_ the cell is loaded, as we can already
    // populate the cell when loading dependencies and thus avoid circular
    // references.
    this.cellsById.set(entityId, entityCell);
    this._subscribeToChanges(entityCell);

    // Start loading the cell
    const loadingPromise = this.storageProvider
      .sync(entityCell.entityId!)
      .then(() => {
        const result = this.storageProvider.get(entityCell.entityId!);
        // If the cell doesn't exist in storage, persist the current value,
        // unless it is undefined. Otherwise, set cell to storage set.
        return result === undefined
          ? entityCell.get() !== undefined
            ? this._sendToStorage(entityCell, this._prepForStorage(entityCell))
            : Promise.resolve()
          : this._sendToCell(entityCell, result.value, result.source);
      })
      .then(() => {
        this.loadingCells.delete(entityCell);
        return entityCell;
      });

    this.loadingCells.set(entityCell, loadingPromise);

    return entityCell;
  }

  private _prepForStorage(cell: CellImpl<any>): any {
    console.log("prep for storage", JSON.stringify(cell.entityId));

    const dependencies = new Set<CellImpl<any>>();

    // Traverse the value and for each cell reference, make sure it's persisted.
    // This is done recursively.
    const traverse = (value: any, path: PropertyKey[]): any => {
      // If it's a cell, make it a cell reference
      if (isCell(value))
        value = { cell: value, path: [] } satisfies CellReference;

      // If it's a cell reference, convert it to a cell reference with an id
      if (isCellReference(value)) {
        // Generate a causal ID for the cell if it doesn't have one yet
        if (!value.cell.entityId) {
          value.cell.generateEntityId({
            cell: StorageImpl.maybeToJSON(cell.entityId),
            path,
          });
        }
        dependencies.add(value.cell);
        return { cell: value.cell.toJSON() /* = the id */, path: value.path };
      } else if (typeof value === "object" && value !== null) {
        if (Array.isArray(value))
          return value.map((value, index) => traverse(value, [...path, index]));
        else
          return Object.fromEntries(
            Object.entries(value).map(([key, value]: [PropertyKey, any]) => [
              key,
              traverse(value, [...path, key]),
            ])
          );
      } else return value;
    };

    // Add source cell as dependent cell
    if (cell.sourceCell) {
      // If there is a source cell, make sure it has an entity ID.
      // It's always the causal child of the result cell.
      if (!cell.sourceCell.entityId)
        cell.sourceCell.generateEntityId(cell.entityId!);
      dependencies.add(cell.sourceCell);
    }

    // Convert all cell references to ids and remember as dependent cells
    this.writeDependentCells.set(cell, dependencies);
    return traverse(cell.get(), []);
  }

  private _sendToStorage(cell: CellImpl<any>, value: any): Promise<void> {
    return this.storageProvider.send(
      cell.entityId!,
      value,
      cell.sourceCell?.entityId
    );
  }

  private _prepForCell(
    cell: CellImpl<any>,
    value: any,
    source?: EntityId
  ): Promise<void> {
    console.log(
      "prep for cell",
      JSON.stringify(cell.entityId),
      value,
      JSON.stringify(source ?? null)
    );

    const dependencies = new Set<CellImpl<any>>();

    const traverse = (value: any): any => {
      if (typeof value === "object" && value !== null)
        if ("cell" in value && "path" in value) {
          // If we see a cell reference with just an id, then we replace it with
          // the actual cell:
          if (
            typeof value.cell === "object" &&
            value.cell !== null &&
            "/" in value.cell &&
            Array.isArray(value.path)
          ) {
            const ref: { cell?: string | CellImpl<any>; path: PropertyKey[] } =
              {
                cell: value.cell, // Still the id, but will be replaced by cell
                path: value.path,
              };
            if (!this.cellsById.has(value.cell))
              this._ensureIsSynced(value.cell);
            ref.cell = this.cellsById.get(value.cell)!;
            dependencies.add(ref.cell);
            return ref;
          } else {
            return value;
          }
        } else if (Array.isArray(value)) return value.map(traverse);
        else
          return Object.fromEntries(
            Object.entries(value).map(([key, value]): any => [
              key,
              traverse(value),
            ])
          );
      else return value;
    };

    if (source) {
      // Make sure the source cell is loaded. Immediately adds it to cellsById.
      if (!this.cellsById.has(JSON.stringify(source)))
        this._ensureIsSynced(source);
      dependencies.add(this.cellsById.get(JSON.stringify(source))!);
    }

    this.readDependentCells.set(cell, dependencies);
    return traverse(value);
  }

  private _sendToCell(
    cell: CellImpl<any>,
    value: any,
    source?: EntityId
  ): void {
    if (source) {
      if (
        cell.sourceCell &&
        JSON.stringify(cell.sourceCell.entityId) !== JSON.stringify(source)
      )
        throw new Error("Cell already has a different source");

      cell.sourceCell = this.cellsById.get(JSON.stringify(source))!;
    }
    cell.send(value);
  }

  // Support referencing as cell, via entity ID or as stringified entity ID
  static fromIdToCell<T>(
    subject: CellImpl<any> | EntityId | string
  ): CellImpl<T> {
    let entityCell: CellImpl<T> | undefined;

    if (isCell(subject)) {
      entityCell = subject;
      if (!entityCell.entityId) throw new Error("Cell has no entity ID");
    } else if (
      (typeof subject === "string" && subject.startsWith('{"/":"')) ||
      (typeof subject === "object" && subject !== null && "/" in subject)
    ) {
      entityCell = getCellByEntityId<T>(JSON.stringify(subject))!;
    } else {
      throw new Error(`Invalid cell or entity ID: ${subject}`);
    }

    return entityCell;
  }

  static maybeToJSON(value: any): any {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof value.toJSON === "function"
    )
      return value.toJSON();
    else return value;
  }

  private _subscribeToChanges(cell: CellImpl<any>): void {
    // Send updates to storage
    this.addCancel(
      cell.updates(() => this._sendToStorage(cell, this._prepForStorage(cell)))
    );

    // Subscribe to storage updates
    this.addCancel(
      this.storageProvider.sink(cell.entityId!, (value, source) =>
        this._sendToCell(cell, this._prepForCell(cell, value, source), source)
      )
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
  /**
   * Send a value to storage.
   *
   * @param entityId - Entity ID to send the value to.
   * @param value - Value to send.
   * @param source - Optional source entity ID.
   * @returns Promise that resolves when the value is sent.
   */
  send<T = any>(entityId: EntityId, value: T, source?: EntityId): Promise<void>;

  /**
   * Sync a value from storage. Use `get()` to retrieve the value.
   *
   * @param entityId - Entity ID to sync.
   * @returns Promise that resolves when the value is synced.
   */
  sync(entityId: EntityId): Promise<void>;

  /**
   * Get a value from the local cache reflecting storage. Call `sync()` first.
   *
   * @param entityId - Entity ID to get the value for.
   * @returns Value and source, or undefined if the value is not in storage.
   */
  get<T = any>(entityId: EntityId): { value: T; source?: EntityId } | undefined;

  /**
   * Subscribe to storage updates.
   *
   * @param entityId - Entity ID to subscribe to.
   * @param callback - Callback function.
   * @returns Cancel function to stop the subscription.
   */
  sink<T = any>(
    entityId: EntityId,
    callback: (value: T, source?: EntityId) => void
  ): Cancel;

  /**
   * Destroy the storage provider. Used for tests only.
   *
   * @returns Promise that resolves when the storage provider is destroyed.
   */
  destroy(): Promise<void>;
}

abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<
    string,
    Set<(value: any, source?: EntityId) => void>
  >();

  abstract send(
    entityId: EntityId,
    value: any,
    source?: EntityId
  ): Promise<void>;

  abstract sync(entityId: EntityId): Promise<void>;

  abstract get(
    entityId: EntityId
  ): { value: any; source?: EntityId } | undefined;

  sink<T = any>(
    entityId: EntityId,
    callback: (value: T, source?: EntityId) => void
  ): Cancel {
    const key = JSON.stringify(entityId);

    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set());
    const listeners = this.subscribers.get(key)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(key);
    };
  }

  protected notifySubscribers(
    key: string,
    value: any,
    source?: EntityId
  ): void {
    console.log(
      "notify subscribers",
      key,
      value,
      JSON.stringify(source ?? null)
    );
    const listeners = this.subscribers.get(key);
    if (listeners) for (const listener of listeners) listener(value, source);
  }

  abstract destroy(): Promise<void>;
}

/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const inMemoryStorage = new Map<string, any>();
const inMemoryStorageSubscribers = new Set<
  (key: string, value: any, source?: EntityId) => void
>();
class InMemoryStorageProvider extends BaseStorageProvider {
  private handleStorageUpdateFn: (key: string, value: any) => void;

  constructor() {
    super();
    this.handleStorageUpdateFn = this.handleStorageUpdate.bind(this);
    inMemoryStorageSubscribers.add(this.handleStorageUpdateFn);
  }

  private handleStorageUpdate(key: string, value: any, source?: EntityId) {
    this.notifySubscribers(key, value, source);
  }

  async send(entityId: EntityId, value: any, source?: EntityId): Promise<void> {
    const key = JSON.stringify(entityId);
    inMemoryStorage.set(key, { value, source });
    inMemoryStorageSubscribers.forEach((listener) =>
      listener(key, value, source)
    );
    this.notifySubscribers(key, value, source);
  }

  async sync(_entityId: EntityId): Promise<void> {
    // No-op
  }

  get(entityId: EntityId): { value: any; source?: EntityId } | undefined {
    if (inMemoryStorage.has(JSON.stringify(entityId)))
      return inMemoryStorage.get(JSON.stringify(entityId));
    else return undefined;
  }

  async destroy(): Promise<void> {
    inMemoryStorageSubscribers.delete(this.handleStorageUpdateFn);
    inMemoryStorage.clear();
    this.subscribers.clear();
  }
}

/**
 * Local storage provider for browser.
 */
class LocalStorageProvider extends BaseStorageProvider {
  private prefix: string;
  private lastValues = new Map<string, string | undefined>();

  private handleStorageEventFn: (event: StorageEvent) => void;

  constructor(prefix: string = "common_storage_") {
    if (typeof window === "undefined" || !window.localStorage)
      throw new Error("LocalStorageProvider is not supported in the browser");
    super();
    this.prefix = prefix;
    this.handleStorageEventFn = this.handleStorageEvent.bind(this);
    window.addEventListener("storage", this.handleStorageEventFn);
  }

  async send(entityId: EntityId, value: any, source?: EntityId): Promise<void> {
    const key = this.getKey(entityId);
    const storeValue = JSON.stringify({ value, source });
    if (this.lastValues.get(key) !== storeValue) {
      console.log(
        "send localstorage",
        JSON.stringify(entityId),
        value,
        this.lastValues.get(key)
      );
      localStorage.setItem(key, storeValue);
      this.lastValues.set(key, storeValue);
    }
  }

  async sync(entityId: EntityId): Promise<void> {
    const key = this.getKey(entityId);
    const value = localStorage.getItem(key);
    console.log("sync localstorage", JSON.stringify(entityId), value);
    if (value === null) this.lastValues.delete(key);
    else this.lastValues.set(key, value);
  }

  get<T>(entityId: EntityId): T | undefined {
    const key = this.getKey(entityId);
    const value = this.lastValues.get(key);
    console.log("get localstorage", JSON.stringify(entityId), value);
    if (value === null || value === undefined) return undefined;
    else return JSON.parse(value) as T;
  }

  async destroy(): Promise<void> {
    window.removeEventListener("storage", this.handleStorageEventFn);
    console.log("clear localstorage", this.prefix);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(this.prefix)) {
        localStorage.removeItem(key);
      }
    }
    this.subscribers.clear();
  }

  private getKey(entityId: EntityId): string {
    return this.prefix + JSON.stringify(entityId);
  }

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key && event.key.startsWith(this.prefix)) {
      const key = event.key.slice(this.prefix.length);
      if (this.lastValues.get(key) !== event.newValue) {
        console.log(
          "storage event",
          event.key,
          event.newValue,
          this.lastValues.get(key)
        );
        if (event.newValue === null) this.lastValues.delete(key);
        else this.lastValues.set(key, event.newValue);
        const result =
          event.newValue !== null ? JSON.parse(event.newValue) : {};
        this.notifySubscribers(key, result.value, result.source);
      }
    }
  };
}
