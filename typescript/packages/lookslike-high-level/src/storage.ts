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
   * Wait for all cells to be synced.
   *
   * @returns Promise that resolves when all cells are synced.
   */
  synced(): Promise<void>;

  /**
   * Clear all stored data.
   * @returns Promise that resolves when the operation is complete.
   */
  destroy(): Promise<void>;
}

type Batch = {
  cell: CellImpl<any>;
  value: { value: any; source?: EntityId };
  destination: "cell" | "storage" | "sync";
}[];

class StorageImpl implements Storage {
  constructor(private storageProvider: StorageProvider) {
    const [cancel, addCancel] = useCancelGroup();
    this.cancel = cancel;
    this.addCancel = addCancel;
  }

  private cellsById = new Map<string, CellImpl<any>>();
  private loadingCells = new Map<CellImpl<any>, Promise<CellImpl<any>>>();
  private syncingCells = new Map<CellImpl<any>, Promise<CellImpl<any>>>();
  private writeDependentCells = new Map<CellImpl<any>, Set<CellImpl<any>>>();
  private readDependentCells = new Map<CellImpl<any>, Set<CellImpl<any>>>();

  private currentBatch: Batch = [];
  private currentBatchProcessing = false;
  private currentBatchResolve: () => void = () => {};
  private currentBatchPromise: Promise<void> = new Promise(
    (r) => (this.currentBatchResolve = r)
  );

  private cancel: Cancel;
  private addCancel: AddCancel;

  syncCell<T>(subject: CellImpl<T> | EntityId | string): Promise<CellImpl<T>> {
    const entityCell = this._fromIdToCell<T>(subject);

    // If the cell is already syncing, return the promise. Or if the cell is
    // already loaded, return immediately
    if (this.syncingCells.has(entityCell))
      return this.syncingCells.get(entityCell)!;
    else if (this.cellsById.has(JSON.stringify(entityCell.entityId)))
      return Promise.resolve(entityCell);

    const promise = this._addToBatch([
      { cell: entityCell, value: { value: undefined }, destination: "sync" },
    ]).then(() => {
      this.syncingCells.delete(entityCell);
      return entityCell;
    });

    this.syncingCells.set(entityCell, promise);

    return promise;
  }

  synced(): Promise<void> {
    return this.currentBatchPromise;
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
    const entityCell = this._fromIdToCell<T>(subject);
    const entityId = JSON.stringify(entityCell.entityId);

    // If the cell is already loaded or loading, return immediately.
    if (this.cellsById.has(entityId)) return entityCell;

    // Important that we set this _before_ the cell is loaded, as we can already
    // populate the cell when loading dependencies and thus avoid circular
    // references.
    this.cellsById.set(entityId, entityCell);
    this._subscribeToChanges(entityCell);

    // Start loading the cell
    const loadingPromise = this.storageProvider
      .sync(entityCell.entityId!)
      .then(() => {
        this.loadingCells.delete(entityCell);
        return entityCell;
      });

    // Being in this set means that we need to wait for the cell to load before
    // calling .get() on storage. Afterwards, it'll always be sync, because we
    // subscribed to the cell.
    this.loadingCells.set(entityCell, loadingPromise);

    return entityCell;
  }

  private _prepForStorage(cell: CellImpl<any>): {
    value: any;
    source?: EntityId;
  } {
    console.log("prep for storage", JSON.stringify(cell.entityId), cell.get());

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
    return {
      value: traverse(cell.get(), []),
      source: cell.sourceCell?.entityId,
    };
  }

  private _sendToStorage(cell: CellImpl<any>, value: any): Promise<void> {
    console.log("send to storage", JSON.stringify(cell.entityId), value);
    return this.storageProvider.send(cell.entityId!, value);
  }

  private _prepForCell(
    cell: CellImpl<any>,
    value: any,
    source?: EntityId
  ): StorageValue<any> {
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
    return { value: traverse(value), source };
  }

  private _sendToCell(
    cell: CellImpl<any>,
    value: any,
    source?: EntityId
  ): void {
    console.log("send to cell", JSON.stringify(cell.entityId), value, source);
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

  private _deduplicateBatch(batch: Batch): Batch {
    // TODO: Implement

    return batch;
  }

  private async _processBatch(batch: Batch): Promise<Batch> {
    const tracking = new Set<CellImpl<any>>();
    const queue = [...batch.map(({ cell }) => cell)];

    // Process sync operations: Ensure they are synced, then remove from the
    // batch. They were added to the queue above, so they'll be processed below.
    batch
      .filter(({ destination }) => destination === "sync")
      .forEach(({ cell }) => this._ensureIsSynced(cell));
    batch = batch.filter(({ destination }) => destination !== "sync");

    while (queue.length > 0) {
      // Wait for cells that are still loading, but only once per cell
      const promises: Promise<CellImpl<any>>[] = [...new Set(queue)]
        .filter((cell) => this.loadingCells.has(cell))
        .map((cell) => this.loadingCells.get(cell)!);

      const loadedCells = await Promise.all(promises);
      queue.length = 0;

      // Process loaded cells, they'll end up on the batch
      for (const cell of loadedCells) {
        // After first load, we set up sync: If storage doesn't know about the
        // cell, we need to persist the current value. If it does, we need to
        // update the cell value.
        const value = this.storageProvider.get(cell.entityId!);
        if (value === undefined)
          batch.push({
            cell,
            value: this._prepForStorage(cell),
            destination: "storage",
          });
        else
          batch.push({
            cell,
            value: this._prepForCell(cell, value.value, value.source),
            destination: "cell",
          });
      }

      for (const { cell, destination } of batch) {
        if (tracking.has(cell)) continue;
        else if (this.loadingCells.has(cell)) queue.push(cell);
        else {
          tracking.add(cell);
          queue.push(
            ...(destination === "cell"
              ? this.readDependentCells.get(cell) ?? []
              : this.writeDependentCells.get(cell) ?? [])
          );
        }
      }
    }

    return batch;
  }

  private async _applyBatch(batch: Batch): Promise<void> {
    const promises: Promise<void>[] = batch
      .filter(({ destination }) => destination === "storage")
      .map(({ cell, value }) => this._sendToStorage(cell, value));
    await Promise.all(promises);

    batch
      .filter(({ destination }) => destination === "cell")
      .forEach(({ cell, value }) =>
        this._sendToCell(cell, value.value, value.source)
      );
  }

  private _processCurrentBatch(): void {
    console.log("process current batch", JSON.stringify(this.currentBatch));

    const resolve = this.currentBatchResolve;

    const batchToApply = this.currentBatch;

    // Reset the current batch, set up the promise for the next batch
    this.currentBatch = [];
    this.currentBatchPromise = new Promise(
      (r) => (this.currentBatchResolve = r)
    );

    this._processBatch(this._deduplicateBatch(batchToApply))
      .then((batch) => this._applyBatch(batch))
      .then(() => {
        // Let everyone waiting for the batch continue their work
        resolve();

        // Trigger the next batch processing, if batch is not empty.
        if (this.currentBatch.length > 0)
          queueMicrotask(() => this._processCurrentBatch());
        else this.currentBatchProcessing = false;
      });
  }

  /**
   * Add a batch to the current batch.
   *
   * If there's no pending batch processing, start processing it in the next
   * microtask (this will also process all other batches added before the
   * microtask starts).
   *
   * If there is a batch processing scheduled, just add it to the list. It'll
   * either get picked up when the currently scheduled processing starts, or it
   * will be processed next.
   *
   * @param batch - Batch to add.
   * @returns Promise that resolves when the batch is processed.
   */
  private _addToBatch(batch: Batch): Promise<void> {
    this.currentBatch.push(...batch);

    if (!this.currentBatchProcessing) {
      this.currentBatchProcessing = true;
      queueMicrotask(() => this._processCurrentBatch());
    }

    return this.currentBatchPromise;
  }

  private _subscribeToChanges(cell: CellImpl<any>): void {
    // Subscribe to cell changes, send updates to storage
    this.addCancel(
      cell.updates((value) =>
        this._addToBatch([
          {
            cell,
            value: { value, source: cell.sourceCell?.entityId },
            destination: "storage",
          },
        ])
      )
    );

    // Subscribe to storage updates, send results to cell
    this.addCancel(
      this.storageProvider.sink(cell.entityId!, (value) =>
        this._addToBatch([
          {
            cell,
            value: this._prepForCell(cell, value.value, value.source),
            destination: "cell",
          },
        ])
      )
    );
  }

  // Support referencing as cell, via entity ID or as stringified entity ID
  private _fromIdToCell<T>(
    subject: CellImpl<any> | EntityId | string
  ): CellImpl<T> {
    if (isCell(subject)) {
      if (!subject.entityId) throw new Error("Cell has no entity ID");
      // If a cell by this id is already known, return the prior one instead.
      return this.cellsById.get(JSON.stringify(subject.entityId)) ?? subject;
    } else if (
      (typeof subject === "string" && subject.startsWith('{"/":"')) ||
      (typeof subject === "object" && subject !== null && "/" in subject)
    ) {
      return getCellByEntityId<T>(subject)!;
    } else {
      throw new Error(`Invalid cell or entity ID: ${subject}`);
    }
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

interface StorageValue<T> {
  value: T;
  source?: EntityId;
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
  send<T = any>(entityId: EntityId, value: StorageValue<T>): Promise<void>;

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
  get<T = any>(entityId: EntityId): StorageValue<T> | undefined;

  /**
   * Subscribe to storage updates.
   *
   * @param entityId - Entity ID to subscribe to.
   * @param callback - Callback function.
   * @returns Cancel function to stop the subscription.
   */
  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void
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

  abstract send(entityId: EntityId, value: StorageValue<any>): Promise<void>;

  abstract sync(entityId: EntityId): Promise<void>;

  abstract get(entityId: EntityId): StorageValue<any> | undefined;

  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void
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

  protected notifySubscribers(key: string, value: StorageValue<any>): void {
    console.log("notify subscribers", key, JSON.stringify(value));
    const listeners = this.subscribers.get(key);
    if (listeners) for (const listener of listeners) listener(value);
  }

  abstract destroy(): Promise<void>;
}

/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const inMemoryStorage = new Map<string, StorageValue<any>>();
const inMemoryStorageSubscribers = new Set<
  (key: string, value: StorageValue<any>) => void
>();
class InMemoryStorageProvider extends BaseStorageProvider {
  private handleStorageUpdateFn: (key: string, value: any) => void;
  private lastValues = new Map<string, string | undefined>();

  constructor() {
    super();
    this.handleStorageUpdateFn = this.handleStorageUpdate.bind(this);
    inMemoryStorageSubscribers.add(this.handleStorageUpdateFn);
  }

  private handleStorageUpdate(key: string, value: StorageValue<any>) {
    const valueString = JSON.stringify(value);
    if (this.lastValues.get(key) !== valueString) {
      this.lastValues.set(key, valueString);
      this.notifySubscribers(key, value);
    }
  }

  async send(entityId: EntityId, value: StorageValue<any>): Promise<void> {
    const key = JSON.stringify(entityId);
    const valueString = JSON.stringify(value);
    if (this.lastValues.get(key) !== valueString) {
      console.log("send inmemory", JSON.stringify(entityId), value);
      this.lastValues.set(key, valueString);
      inMemoryStorage.set(key, value);
      inMemoryStorageSubscribers.forEach((listener) => listener(key, value));
    }
  }

  sync(entityId: EntityId): Promise<void> {
    const key = JSON.stringify(entityId);
    if (inMemoryStorage.has(key))
      this.lastValues.set(key, JSON.stringify(inMemoryStorage.get(key)!));
    else this.lastValues.delete(key);
    return Promise.resolve();
  }

  get(entityId: EntityId): StorageValue<any> | undefined {
    const key = JSON.stringify(entityId);
    console.log("get inmemory", JSON.stringify(entityId));
    return this.lastValues.has(key)
      ? (JSON.parse(this.lastValues.get(key)!) as StorageValue<any>)
      : undefined;
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

  async send(entityId: EntityId, value: StorageValue<any>): Promise<void> {
    const key = this.getKey(entityId);
    const storeValue = JSON.stringify(value);
    if (this.lastValues.get(key) !== storeValue) {
      localStorage.setItem(key, storeValue);
      this.lastValues.set(key, storeValue);
      console.log(
        "send localstorage",
        JSON.stringify(entityId),
        storeValue,
        this.lastValues
      );
    }
  }

  async sync(entityId: EntityId): Promise<void> {
    const key = this.getKey(entityId);
    const value = localStorage.getItem(key);
    console.log("sync localstorage", JSON.stringify(entityId), value);
    if (value === null) this.lastValues.delete(key);
    else this.lastValues.set(key, value);
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = this.getKey(entityId);
    const value = this.lastValues.get(key);
    console.log("get localstorage", JSON.stringify(entityId), value);
    if (value === null || value === undefined) return undefined;
    else return JSON.parse(value) as StorageValue<T>;
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
      if (this.lastValues.get(event.key) !== event.newValue) {
        console.log(
          "storage event",
          event.key,
          event.newValue,
          this.lastValues.get(event.key),
          this.lastValues
        );
        if (event.newValue === null) this.lastValues.delete(event.key);
        else this.lastValues.set(event.key, event.newValue);
        const result =
          event.newValue !== null ? JSON.parse(event.newValue) : {};
        this.notifySubscribers(event.key, result);
      }
    }
  };
}
