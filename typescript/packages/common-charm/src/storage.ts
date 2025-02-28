import {
  type AddCancel,
  type Cancel,
  Cell,
  type DocImpl,
  type DocLink,
  type EntityId,
  getDocByEntityId,
  getDocLinkOrThrow,
  idle,
  isCell,
  isDoc,
  isDocLink,
  isQueryResultForDereferencing,
  Space,
  useCancelGroup,
} from "@commontools/runner";
import { isStatic, markAsStatic } from "@commontools/builder";
import { StorageProvider, StorageValue } from "./storage/base.ts";
import { RemoteStorageProvider } from "./storage/remote.ts";
import { debug } from "@commontools/html"; // FIXME(ja): can we move debug to somewhere else?
import { InMemoryStorageProvider } from "./storage/memory.ts";

export function log(fn: () => any[]) {
  debug(() => {
    // Get absolute time in milliseconds since Unix epoch
    const absoluteMs = (performance.timeOrigin % 3600000) +
      (performance.now() % 1000);

    // Extract components
    const totalSeconds = Math.floor(absoluteMs / 1000);
    const minutes = Math.floor((totalSeconds % 3600) / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    const millis = Math.floor(absoluteMs % 1000)
      .toString()
      .padStart(3, "0");
    const nanos = Math.floor((absoluteMs % 1) * 1000000)
      .toString()
      .padStart(6, "0");

    return [`${minutes}:${seconds}:${millis}:${nanos}`, ...fn()];
  });
}

export interface Storage {
  /**
   * Set remote storage URL.
   *
   * @param url - URL to set.
   */
  setRemoteStorage(url: URL): void;

  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * This will currently also follow all encountered cell references and load
   * these cells as well.
   *
   * This works also for cells that haven't been persisted yet. In that case,
   * it'll write the current value into storage.
   *
   * @param cell - Document / Cell to load into.
   * @param expectedInStorage - Whether the cell is expected to be in storage.
   * @returns Promise that resolves to the cell when it is loaded.
   * @throws Will throw if called on a cell without an entity ID.
   */
  syncCell<T = any>(
    cell: DocImpl<T> | Cell<any>,
    expectedInStorage?: boolean,
  ): Promise<DocImpl<T>> | DocImpl<T>;

  /**
   * Same as above.
   *
   * @param space - Space to load from.
   * @param id - Entity ID as EntityId or string.
   * @param expectedInStorage - Whether the cell is expected to be in storage.
   * @returns Promise that resolves to the cell when it is loaded.
   */
  syncCellById<T = any>(
    space: Space,
    cell: EntityId | string,
    expectedInStorage?: boolean,
  ): Promise<DocImpl<T>> | DocImpl<T>;

  /**
   * Wait for all cells to be synced.
   *
   * @returns Promise that resolves when all cells are synced.
   */
  synced(): Promise<void>;

  /**
   * Cancel all subscriptions and stop syncing.
   *
   * @returns Promise that resolves when the storage is destroyed.
   */
  cancelAll(): Promise<void>;
}

type Job = {
  cell: DocImpl<any>;
  type: "cell" | "storage" | "sync";
};

/**
 * Storage implementation.
 *
 * Life-cycle of a cell: (1) not known to storage – a cell might just be a
 *  temporary cell, e.g. holding input bindings or so (2) known to storage, but
 *  not yet loaded – we know about the cell, but don't have the data yet. (3)
 *  Once loaded, if there was data in storage, we overwrite the current value of
 *  the cell, and if there was no data in storage, we use the current value of
 *  the cell and write it to storage. (4) The cell is subscribed to updates from
 *  storage and cells, and each time the cell changes, the new value is written
 *  to storage, and vice versa.
 *
 * But reading and writing don't happen in one step: We follow all cell
 * references and make sure all cells are loaded before we start writing. This
 * is recursive, so if cell A references cell B, and cell B references cell C,
 * then cell C will also be loaded when we process cell A. We might receive
 * updates for cells (either locally or from storage), while we wait for the
 * cells to load, and this might introduce more dependencies, and we'll pick
 * those up as well. For now, we wait until we reach a stable point, i.e. no
 * loading cells pending, but we might instead want to eventually queue up
 * changes instead.
 *
 * Following references depends on the direction of the write: When writing from
 * a cell to storage, we turn cell references into ids. When writing from
 * storage to a cell, we turn ids into cell references.
 *
 * In the future we should be smarter about whether the local state or remote
 * state is more up to date. For now we assume that the remote state is always
 * more current. The idea is that the local state is optimistically executing
 * on possibly stale state, while if there is something in storage, another node
 * is probably already further ahead.
 */
class StorageImpl implements Storage {
  constructor() {
    const [cancel, addCancel] = useCancelGroup();
    this.cancel = cancel;
    this.addCancel = addCancel;

    // Check if we're in a browser environment before accessing location
    if (
      typeof globalThis !== "undefined" &&
      typeof globalThis.location !== "undefined" &&
      globalThis.location?.href
    ) {
      this.setRemoteStorage(new URL(globalThis.location.href));
    }
  }

  // Map from space to storage provider. TODO: Push spaces to storage providers.
  private storageProviders = new Map<Space, StorageProvider>();
  private remoteStorageUrl: URL | undefined;

  // Map from entity ID to cell, set at stage 2, i.e. already while loading
  private cellsById = new Map<string, DocImpl<any>>();

  // Map from cell to promise of loading cell, set at stage 2. Resolves when
  // cell and all it's dependencies are loaded.
  private cellIsLoading = new Map<DocImpl<any>, Promise<DocImpl<any>>>();

  // Resolves for the promises above. Only called by batch processor.
  private loadingPromises = new Map<DocImpl<any>, Promise<DocImpl<any>>>();
  private loadingResolves = new Map<DocImpl<any>, () => void>();

  // Map from cell to latest transformed values and set of cells that depend on
  // it. "Write" is from cell to storage, "read" is from storage to cell. For
  // values that means either all cell ids (write) or all cells (read) in cell
  // references.
  private writeDependentCells = new Map<DocImpl<any>, Set<DocImpl<any>>>();
  private writeValues = new Map<DocImpl<any>, StorageValue<any>>();
  private readDependentCells = new Map<DocImpl<any>, Set<DocImpl<any>>>();
  private readValues = new Map<
    DocImpl<any>,
    { value: any; source?: DocImpl<any> }
  >();

  private currentBatch: Job[] = [];
  private currentBatchProcessing = false;
  private currentBatchResolve: () => void = () => {};
  private currentBatchPromise: Promise<void> = new Promise((
    r,
  ) => (this.currentBatchResolve = r));
  private lastBatchTime: number = 0;
  private lastBatchDebounceCount: number = 0;

  private cancel: Cancel;
  private addCancel: AddCancel;

  setRemoteStorage(url: URL): void {
    this.remoteStorageUrl = url;
  }

  syncCellById<T>(
    space: Space,
    id: EntityId | string,
    expectedInStorage: boolean = false,
  ): Promise<DocImpl<T>> | DocImpl<T> {
    return this.syncCell(
      getDocByEntityId<T>(space, id, true)!,
      expectedInStorage,
    );
  }

  syncCell<T>(
    subject: DocImpl<T> | Cell<any>,
    expectedInStorage: boolean = false,
  ): Promise<DocImpl<T>> | DocImpl<T> {
    const entityCell = this._ensureIsSynced(subject, expectedInStorage);

    // If cell is loading, return the promise. Otherwise return immediately.
    return this.cellIsLoading.get(entityCell) ?? entityCell;
  }

  synced(): Promise<void> {
    // If there's no batch processing and no pending batch, resolve immediately
    if (!this.currentBatchProcessing && this.currentBatch.length === 0) {
      return Promise.resolve();
    }

    return this.currentBatchPromise;
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      Array.from(this.storageProviders.values()).map((provider) =>
        provider.destroy()
      ),
    );
    this.cellsById.clear();
    this.cellIsLoading.clear();
    this.cancel();
  }

  // TODO: Should just be one again.
  private _getStorageProviderForSpace(space: Space): StorageProvider {
    if (!space) throw new Error("No space set");

    let provider = this.storageProviders.get(space);

    if (!provider) {
      // Default to "remote", but let either custom URL (used in tests) or
      // environment variable override this.
      const type = this.remoteStorageUrl?.protocol === "memory:"
        ? "memory"
        : ((import.meta as any).env?.VITE_STORAGE_TYPE ?? "remote");

      if (type === "remote") {
        if (!this.remoteStorageUrl) {
          throw new Error("No remote storage URL set");
        }

        provider = new RemoteStorageProvider({
          address: new URL("/api/storage/memory", this.remoteStorageUrl!),
          space: space.uri as `did:${string}:${string}`,
        });
      } else if (type === "memory") {
        provider = new InMemoryStorageProvider(space.uri);
      } else {
        throw new Error(`Unknown storage type: ${type}`);
      }
      this.storageProviders.set(space, provider);
    }
    return provider;
  }

  private _ensureIsSyncedById<T>(
    space: Space,
    id: EntityId | string,
    expectedInStorage: boolean = false,
  ): DocImpl<T> {
    return this._ensureIsSynced(
      getDocByEntityId<T>(space, id, true)!,
      expectedInStorage,
    );
  }

  private _ensureIsSynced<T>(
    subject: DocImpl<T> | Cell<any>,
    expectedInStorage: boolean = false,
  ): DocImpl<T> {
    if (isCell(subject)) subject = subject.getAsDocLink().cell;
    if (!isDoc(subject)) {
      throw new Error("Invalid subject: " + JSON.stringify(subject));
    }
    if (!subject.entityId) throw new Error("Cell has no entity ID");

    const entityCell = this.cellsById.get(JSON.stringify(subject.entityId)) ??
      subject;
    const entityId = JSON.stringify(entityCell.entityId);

    // If the cell is ephemeral, we don't need to load it from storage. We still
    // add it to the map of known cells, so that we don't try to keep loading
    // it.
    if (entityCell.ephemeral) {
      this.cellsById.set(entityId, entityCell);
      return entityCell;
    }

    // If the cell is already loaded or loading, return immediately.
    if (this.cellsById.has(entityId)) return entityCell;

    // Important that we set this _before_ the cell is loaded, as we can already
    // populate the cell when loading dependencies and thus avoid circular
    // references.
    this.cellsById.set(entityId, entityCell);

    // Start loading the cell and safe the promise for processBatch to await for
    const loadingPromise = this._getStorageProviderForSpace(entityCell.space!)
      .sync(entityCell.entityId!, expectedInStorage)
      .then(() => entityCell);
    this.loadingPromises.set(entityCell, loadingPromise);

    // Create a promise that gets resolved once the cell and all its
    // dependencies are loaded. It'll return the cell when done.
    const cellIsLoadingPromise = new Promise<void>((r) =>
      this.loadingResolves.set(entityCell, r)
    ).then(() => entityCell);
    this.cellIsLoading.set(entityCell, cellIsLoadingPromise);

    this._addToBatch([{ cell: entityCell, type: "sync" }]);

    // Return the cell, to make calls chainable.
    return entityCell;
  }

  // Prepares value for storage, and updates dependencies, triggering cell loads
  // if necessary. Updates this.writeValues and this.writeDependentCells.
  private _batchForStorage(cell: DocImpl<any>): void {
    // If the cell is ephemeral, this is a no-op.
    if (cell.ephemeral) {
      console.warn(
        "attempted to batch write to ephemeral cell in storage: ",
        JSON.stringify(cell.entityId),
      );
      return;
    }

    const dependencies = new Set<DocImpl<any>>();

    // Traverse the value and for each cell reference, make sure it's persisted.
    // This is done recursively.
    const traverse = (
      value: any,
      path: PropertyKey[],
      processStatic: boolean = false,
    ): any => {
      // If it's a cell, make it a cell reference
      if (isDoc(value)) value = { cell: value, path: [] } satisfies DocLink;

      // If it's a query result proxy, make it a cell reference
      if (isQueryResultForDereferencing(value)) {
        value = getDocLinkOrThrow(value);
      }

      // If it's a cell reference, convert it to a cell reference with an id
      if (isDocLink(value)) {
        // Generate a causal ID for the cell if it doesn't have one yet
        if (!value.cell.entityId) {
          value.cell.generateEntityId(
            {
              cell: cell.entityId?.toJSON
                ? cell.entityId.toJSON()
                : cell.entityId,
              path,
            },
            cell.space!,
          );
        }
        dependencies.add(this._ensureIsSynced(value.cell));
        return { ...value, cell: value.cell.toJSON() /* = the id */ };
      } else if (isStatic(value) && !processStatic) {
        return { $static: traverse(value, path, true) };
      } else if (typeof value === "object" && value !== null) {
        if (Array.isArray(value)) {
          return value.map((value, index) => traverse(value, [...path, index]));
        } else {
          return Object.fromEntries(
            Object.entries(value).map(([key, value]: [PropertyKey, any]) => [
              key,
              traverse(value, [...path, key]),
            ]),
          );
        }
      } else return value;
    };

    // Add source cell as dependent cell
    if (cell.sourceCell) {
      // If there is a source cell, make sure it has an entity ID.
      // It's always the causal child of the result cell.
      if (!cell.sourceCell.entityId) {
        cell.sourceCell.generateEntityId(cell.entityId!);
      }
      dependencies.add(this._ensureIsSynced(cell.sourceCell));
    }

    // Convert all cell references to ids and remember as dependent cells
    const value: StorageValue = {
      value: traverse(cell.get(), []),
      source: cell.sourceCell?.entityId,
    };

    if (JSON.stringify(value) !== JSON.stringify(this.writeValues.get(cell))) {
      this.writeDependentCells.set(cell, dependencies);
      this.writeValues.set(cell, value);

      this._addToBatch([{ cell, type: "storage" }]);

      log(() => [
        "prep for storage",
        JSON.stringify(cell.entityId),
        value,
        [...dependencies].map((c) => JSON.stringify(c.entityId)),
      ]);
    }
  }

  // Prepares value for cells, and updates dependencies, triggering cell loads
  // if necessary. Updates this.readValues and this.readDependentCells.
  private _batchForCell(
    cell: DocImpl<any>,
    value: any,
    source?: EntityId,
  ): void {
    log(() => [
      "prep for cell",
      JSON.stringify(cell.entityId),
      value,
      JSON.stringify(source ?? null),
    ]);

    const dependencies = new Set<DocImpl<any>>();

    const traverse = (value: any): any => {
      if (typeof value !== "object" || value === null) {
        return value;
      } else if ("cell" in value && "path" in value) {
        // If we see a cell reference with just an id, then we replace it with
        // the actual cell:
        if (
          typeof value.cell === "object" &&
          value.cell !== null &&
          "/" in value.cell &&
          Array.isArray(value.path)
        ) {
          // If the cell is not yet loaded, load it. As it's referenced in
          // something that came from storage, the id is known in storage and so
          // we have to wait for it to load. Hence true as second parameter.
          const dependency = this._ensureIsSyncedById(
            cell.space!,
            value.cell,
            true,
          );
          dependencies.add(dependency);
          return { ...value, cell: dependency };
        } else {
          console.warn("unexpected cell reference", value);
          return value;
        }
      } else if ("$static" in value) {
        return markAsStatic(traverse(value.$static));
      } else if (Array.isArray(value)) {
        return value.map(traverse);
      } else {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]): any => [k, traverse(v)]),
        );
      }
    };

    // Make sure the source cell is loaded, and add it as a dependency
    const newValue: { value: any; source?: DocImpl<any> } = {
      value: traverse(value),
    };

    if (source) {
      const sourceCell = this._ensureIsSyncedById(cell.space!, source, true);
      dependencies.add(sourceCell);
      newValue.source = sourceCell;
    }

    if (
      JSON.stringify(newValue) !== JSON.stringify(this.readValues.get(cell))
    ) {
      this.readDependentCells.set(cell, dependencies);
      this.readValues.set(cell, newValue);

      this._addToBatch([{ cell, type: "cell" }]);
    }
  }

  // Processes the current batch, returns final operations to apply all at once
  // while clearing the batch.
  //
  // In a loop will:
  // - For all loaded cells, collect dependencies and add those to list of cells
  // - Await loading of all remaining cells, then add read/write to batch,
  //   install listeners, resolve loading promise
  // - Once no cells are left to load, convert batch jobs to ops by copying over
  //   the current values
  //
  // An invariant we can use: If a cell is loaded and _not_ in the batch, then
  // it is current, and we don't need to verify it's dependencies. That's
  // because once a cell is loaded, updates come in via listeners only, and they
  // add entries to tbe batch.
  private async _processCurrentBatch(): Promise<void> {
    const loading = new Set<DocImpl<any>>();
    const loadedCells = new Set<DocImpl<any>>();

    log(() => [
      "processing batch",
      this.currentBatch.map(({ cell, type }) =>
        `${JSON.stringify(cell.entityId)}:${type}`
      ),
    ]);

    do {
      // Load everything in loading
      const loaded = await Promise.all(
        Array.from(loading).map((cell) => this.loadingPromises.get(cell)!),
      );
      if (loading.size === 0) {
        // If there was nothing queued, let the event loop settle before
        // continuing. We might have gotten new data from storage.
        await new Promise((r) => setTimeout(r, 0));
      }
      loading.clear();

      for (const cell of loaded) {
        loadedCells.add(cell);

        // After first load, we set up sync: If storage doesn't know about the
        // cell, we need to persist the current value. If it does, we need to
        // update the cell value.
        const value = this._getStorageProviderForSpace(cell.space!).get(
          cell.entityId!,
        );
        if (value === undefined) this._batchForStorage(cell);
        else this._batchForCell(cell, value.value, value.source);

        // From now on, we'll get updates via listeners
        this._subscribeToChanges(cell);
      }

      // For each entry in the batch, find all dependent not yet loaded cells.
      // Note that this includes both cells just added above, after loading and
      // cells that were updated in the meantime and possibly gained
      // dependencies.
      for (const { cell, type } of this.currentBatch) {
        if (type === "sync") {
          if (this.cellIsLoading.has(cell) && !loadedCells.has(cell)) {
            loading.add(cell);
          }
        } else {
          // Invariant: Jobs with "cell" or "storage" type are already loaded.
          // But dependencies might change, even while this loop is running.
          const dependentCells = type === "cell"
            ? this.readDependentCells.get(cell)
            : this.writeDependentCells.get(cell);
          log(() => [
            "dependent cells",
            JSON.stringify(cell.entityId),
            [...dependentCells!].map((c) => JSON.stringify(c.entityId)),
          ]);
          if (dependentCells) {
            Array.from(dependentCells)
              .filter(
                (dependent) =>
                  this.cellIsLoading.has(dependent) &&
                  !loadedCells.has(dependent),
              )
              .forEach((dependent) => loading.add(dependent));
          }
        }
      }
      log(
        () => ["loading", [...loading].map((c) => JSON.stringify(c.entityId))],
      );
      log(() => [
        "cellIsLoading",
        [...this.cellIsLoading.keys()].map((c) => JSON.stringify(c.entityId)),
      ]);
      log(() => [
        "currentBatch",
        this.currentBatch.map(({ cell, type }) =>
          `${JSON.stringify(cell.entityId)}:${type}`
        ),
      ]);
    } while (loading.size > 0);

    // Convert batch jobs to operations:
    const cellJobs = new Map(
      this.currentBatch
        .filter(({ type }) => type === "cell")
        .map(({ cell }) => [cell, this.readValues.get(cell)!]),
    );
    const storageJobs = new Map(
      this.currentBatch
        .filter(({ type }) => type === "storage")
        .map(({ cell }) => [cell, this.writeValues.get(cell)!]),
    );

    // Reset batch: Everything coming in now will be processed in the next round
    const currentResolve = this.currentBatchResolve;
    this.currentBatch = [];
    this.currentBatchPromise = new Promise((
      r,
    ) => (this.currentBatchResolve = r));

    // Don't update cells while they might be updating.
    await idle();

    // Storage jobs override cell jobs. Write remaining cell jobs to cell.
    cellJobs.forEach(({ value, source }, cell) => {
      // TODO(seefeld): For frozen cells, show a warning if content is different.
      // But also, we should serialize the fact that it is frozen to begin with...
      if (!storageJobs.has(cell) && !cell.isFrozen()) {
        if (source) {
          cell.sourceCell = this.cellsById.get(JSON.stringify(source))!;
        }

        log(
          () => [
            "send to cell",
            JSON.stringify(cell.entityId),
            JSON.stringify(value),
          ],
        );
        cell.send(value);
      }
    });

    // Sort storage jobs by space
    const storageJobsBySpace = new Map<
      Space,
      { entityId: EntityId; value: any }[]
    >();
    storageJobs.forEach((value, cell) => {
      const space = cell.space!;
      if (!storageJobsBySpace.has(space)) storageJobsBySpace.set(space, []);
      storageJobsBySpace.get(space)!.push({ entityId: cell.entityId!, value });
    });

    // Write all storage jobs to storage, in parallel
    await Promise.all(
      Array.from(storageJobsBySpace.keys()).map(async (space) =>
        this._getStorageProviderForSpace(space).send(
          storageJobsBySpace.get(space)!.map(({ entityId, value }) => ({
            entityId,
            value,
          })),
        )
      ),
    );

    // Finally, clear and resolve loading promise for all loaded cells
    for (const cell of loadedCells) {
      const resolve = this.loadingResolves.get(cell);
      this.loadingPromises.delete(cell);
      this.cellIsLoading.delete(cell);
      resolve?.();
    }

    // Notify everyone waiting for the batch to finish
    currentResolve();
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
  private _addToBatch(batch: Job[]): Promise<void> {
    this.currentBatch.push(...batch);

    if (!this.currentBatchProcessing) {
      this.currentBatchProcessing = true;

      const task = () =>
        this._processCurrentBatch().then(() => {
          this.currentBatchProcessing = false;

          // Trigger processing of next batch, if we got new ones while
          // applying operations or after resolving the current batch promise
          if (this.currentBatch.length > 0) this._addToBatch([]);
        });

      const now = Date.now();
      if (now - this.lastBatchTime < 100) {
        if (this.lastBatchDebounceCount < 17) this.lastBatchDebounceCount++;

        // First 10 have no delay, then it's 50, 100, 200, 400, ..., 1600
        // + random to next interval so not all tabs debounce synchronously
        const exp = Math.max(0, this.lastBatchDebounceCount - 10) ** 2;
        const delay = 50 * exp * (1 + Math.random());

        if (delay > 1000) console.warn(`debouncing by ${delay}ms`);

        setTimeout(() => {
          this.lastBatchTime = Date.now();
          task();
        }, delay);
      } else {
        this.lastBatchTime = now;
        this.lastBatchDebounceCount = 0;
        queueMicrotask(task);
      }
    }

    return this.currentBatchPromise;
  }

  private _subscribeToChanges(cell: DocImpl<any>): void {
    log(() => ["subscribe to changes", JSON.stringify(cell.entityId)]);

    // Subscribe to cell changes, send updates to storage
    this.addCancel(
      cell.updates((value) => {
        log(
          () => [
            "got from cell",
            JSON.stringify(cell.entityId),
            JSON.stringify(value),
          ],
        );
        return this._batchForStorage(cell);
      }),
    );

    // Subscribe to storage updates, send results to cell
    this.addCancel(
      this._getStorageProviderForSpace(cell.space!).sink(
        cell.entityId!,
        (value) => this._batchForCell(cell, value.value, value.source),
      ),
    );
  }
}

export const storage = new StorageImpl();
