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
import {
  StorageProvider,
  StorageValue,
  LocalStorageProvider,
  InMemoryStorageProvider,
} from "./storage-providers.js";

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
    const value = traverse(cell.get(), []);
    this.writeDependentCells.set(cell, dependencies);
    return { value, source: cell.sourceCell?.entityId };
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
            const cell = this._ensureIsSynced(value.cell);
            dependencies.add(cell);
            return { cell, path: value.path };
          } else {
            console.warn("unexpected cell reference", value);
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

    // Make sure the source cell is loaded, and add it as a dependency
    if (source) dependencies.add(this._ensureIsSynced(source));

    value = traverse(value);
    this.readDependentCells.set(cell, dependencies);
    return { value, source };
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
