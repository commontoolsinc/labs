import { type DocImpl, isDoc } from "./doc.ts";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import { Cell, type CellLink, isCell, isCellLink } from "./cell.ts";
import { type EntityId, getDocByEntityId } from "./doc-map.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { idle } from "./scheduler.ts";
import { isStatic, markAsStatic } from "@commontools/builder";
import { StorageProvider, StorageValue } from "./storage/base.ts";
import { RemoteStorageProvider } from "./storage/remote.ts";
import { debug } from "@commontools/html"; // FIXME(ja): can we move debug to somewhere else?
import { VolatileStorageProvider } from "./storage/volatile.ts";
import { Signer } from "@commontools/identity";
import { isBrowser } from "@commontools/utils/env";

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

  setSigner(signer: Signer): void;

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
    space: string,
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
  doc: DocImpl<any>;
  type: "doc" | "storage" | "sync";
};

/**
 * Storage implementation.
 *
 * Life-cycle of a doc: (1) not known to storage – a doc might just be a
 *  temporary doc, e.g. holding input bindings or so (2) known to storage, but
 *  not yet loaded – we know about the doc, but don't have the data yet. (3)
 *  Once loaded, if there was data in storage, we overwrite the current value of
 *  the doc, and if there was no data in storage, we use the current value of
 *  the doc and write it to storage. (4) The doc is subscribed to updates from
 *  storage and docs, and each time the doc changes, the new value is written
 *  to storage, and vice versa.
 *
 * But reading and writing don't happen in one step: We follow all doc
 * references and make sure all docs are loaded before we start writing. This
 * is recursive, so if doc A references doc B, and doc B references doc C,
 * then doc C will also be loaded when we process doc A. We might receive
 * updates for docs (either locally or from storage), while we wait for the
 * docs to load, and this might introduce more dependencies, and we'll pick
 * those up as well. For now, we wait until we reach a stable point, i.e. no
 * loading docs pending, but we might instead want to eventually queue up
 * changes instead.
 *
 * Following references depends on the direction of the write: When writing from
 * a doc to storage, we turn doc references into ids. When writing from
 * storage to a doc, we turn ids into doc references.
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
    if (isBrowser()) {
      this.setRemoteStorage(new URL(globalThis.location.href));
    }
  }

  // Map from space to storage provider. TODO: Push spaces to storage providers.
  private storageProviders = new Map<string, StorageProvider>();
  private remoteStorageUrl: URL | undefined;

  private signer: Signer | undefined;

  // Any doc here is being synced or in the process of spinning up syncing.
  // See also docIsLoading, which is a promise while the document is loading,
  // and is deleted after it is loaded.
  private docIsSyncing = new Set<DocImpl<any>>();

  // Map from doc to promise of loading doc, set at stage 2. Resolves when
  // doc and all it's dependencies are loaded.
  private docIsLoading = new Map<DocImpl<any>, Promise<DocImpl<any>>>();

  // Resolves for the promisxes above. Only called by batch processor.
  private loadingPromises = new Map<DocImpl<any>, Promise<DocImpl<any>>>();
  private loadingResolves = new Map<DocImpl<any>, () => void>();

  // Map from doc to latest transformed values and set of docs that depend on
  // it. "Write" is from doc to storage, "read" is from storage to doc. For
  // values that means either all doc ids (write) or all docs (read) in doc
  // references.
  private writeDependentDocs = new Map<DocImpl<any>, Set<DocImpl<any>>>();
  private writeValues = new Map<DocImpl<any>, StorageValue<any>>();
  private readDependentDocs = new Map<DocImpl<any>, Set<DocImpl<any>>>();
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
  private debounceTimeout: number | null = null;
  private batchStartTime: number = 0;

  private cancel: Cancel;
  private addCancel: AddCancel;

  setRemoteStorage(url: URL): void {
    this.remoteStorageUrl = url;
  }

  setSigner(signer: Signer): void {
    this.signer = signer;
  }

  syncCellById<T>(
    space: string,
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

    // If doc is loading, return the promise. Otherwise return immediately.
    return this.docIsLoading.get(entityCell) ?? entityCell;
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
    this.docIsLoading.clear();
    this.cancel();
  }

  // TODO(seefeld,gozala): Should just be one again.
  private _getStorageProviderForSpace(space: string): StorageProvider {
    if (!space) throw new Error("No space set");
    if (!this.signer) throw new Error("No signer set");

    let provider = this.storageProviders.get(space);

    if (!provider) {
      // Default to "remote", but let either custom URL (used in tests) or
      // environment variable override this.
      const type = this.remoteStorageUrl?.protocol === "volatile:"
        ? "volatile"
        : ((import.meta as any).env?.VITE_STORAGE_TYPE ?? "remote");

      if (type === "remote") {
        if (!this.remoteStorageUrl) {
          throw new Error("No remote storage URL set");
        }

        provider = new RemoteStorageProvider({
          address: new URL("/api/storage/memory", this.remoteStorageUrl!),
          space: space as `did:${string}:${string}`,
          as: this.signer,
        });
      } else if (type === "volatile") {
        provider = new VolatileStorageProvider(space);
      } else {
        throw new Error(`Unknown storage type: ${type}`);
      }
      this.storageProviders.set(space, provider);
    }
    return provider;
  }

  private _ensureIsSyncedById<T>(
    space: string,
    id: EntityId | string,
    expectedInStorage: boolean = false,
  ): DocImpl<T> {
    return this._ensureIsSynced(
      getDocByEntityId<T>(space, id, true)!,
      expectedInStorage,
    );
  }

  private _ensureIsSynced<T>(
    doc: DocImpl<T> | Cell<any>,
    expectedInStorage: boolean = false,
  ): DocImpl<T> {
    if (isCell(doc)) doc = doc.getAsCellLink().cell;
    if (!isDoc(doc)) {
      throw new Error("Invalid subject: " + JSON.stringify(doc));
    }
    if (!doc.entityId) throw new Error("Doc has no entity ID");

    const entityId = JSON.stringify(doc.entityId);

    // If the doc is ephemeral, we don't need to load it from storage. We still
    // add it to the map of known docs, so that we don't try to keep loading
    // it.
    if (doc.ephemeral) return doc;

    // If the doc is already loaded or loading, return immediately.
    if (this.docIsSyncing.has(doc)) return doc;

    // Important that we set this _before_ the doc is loaded, as we can already
    // populate the doc when loading dependencies and thus avoid circular
    // references.
    this.docIsSyncing.add(doc);

    // Start loading the doc and safe the promise for processBatch to await for
    const loadingPromise = this._getStorageProviderForSpace(doc.space)
      .sync(doc.entityId!, expectedInStorage)
      .then(() => doc);
    this.loadingPromises.set(doc, loadingPromise);

    // Create a promise that gets resolved once the doc and all its
    // dependencies are loaded. It'll return the doc when done.
    const docIsLoadingPromise = new Promise<void>((r) =>
      this.loadingResolves.set(doc, r)
    ).then(() => doc);
    this.docIsLoading.set(doc, docIsLoadingPromise);

    this._addToBatch([{ doc: doc, type: "sync" }]);

    // Return the doc, to make calls chainable.
    return doc;
  }

  // Prepares value for storage, and updates dependencies, triggering doc loads
  // if necessary. Updates this.writeValues and this.writeDependentDocs.
  private _batchForStorage(doc: DocImpl<any>): void {
    // If the doc is ephemeral, this is a no-op.
    if (doc.ephemeral) {
      console.warn(
        "attempted to batch write to ephemeral doc in storage: ",
        JSON.stringify(doc.entityId),
      );
      return;
    }

    const dependencies = new Set<DocImpl<any>>();

    // Traverse the value and for each doc reference, make sure it's persisted.
    // This is done recursively.
    const traverse = (
      value: any,
      path: PropertyKey[],
      processStatic: boolean = false,
    ): any => {
      // If it's a doc, make it a doc link
      if (isDoc(value)) value = { cell: value, path: [] } satisfies CellLink;

      // If it's a query result proxy, make it a doc link
      if (isQueryResultForDereferencing(value)) {
        value = getCellLinkOrThrow(value);
      }

      // If it's a doc link, convert it to a doc link with an id
      if (isCellLink(value)) {
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

    // Add source doc as dependent doc
    if (doc.sourceCell) dependencies.add(this._ensureIsSynced(doc.sourceCell));

    // Convert all doc references to ids and remember as dependent docs
    const value: StorageValue = {
      value: traverse(doc.get(), []),
      source: doc.sourceCell?.entityId,
    };

    if (JSON.stringify(value) !== JSON.stringify(this.writeValues.get(doc))) {
      this.writeDependentDocs.set(doc, dependencies);
      this.writeValues.set(doc, value);

      this._addToBatch([{ doc, type: "storage" }]);

      log(() => [
        "prep for storage",
        JSON.stringify(doc.entityId),
        value,
        [...dependencies].map((c) => JSON.stringify(c.entityId)),
      ]);
    }
  }

  // Prepares value for docs, and updates dependencies, triggering doc loads
  // if necessary. Updates this.readValues and this.readDependentDocs.
  private _batchForDoc(
    doc: DocImpl<any>,
    value: any,
    source?: EntityId,
  ): void {
    log(() => [
      "prep for doc",
      JSON.stringify(doc.entityId),
      value,
      JSON.stringify(source ?? null),
    ]);

    const dependencies = new Set<DocImpl<any>>();

    const traverse = (value: any): any => {
      if (typeof value !== "object" || value === null) {
        return value;
      } else if ("cell" in value && "path" in value) {
        // If we see a doc link with just an id, then we replace it with
        // the actual doc:
        if (
          typeof value.cell === "object" &&
          value.cell !== null &&
          "/" in value.cell &&
          Array.isArray(value.path)
        ) {
          // If the doc is not yet loaded, load it. As it's referenced in
          // something that came from storage, the id is known in storage and so
          // we have to wait for it to load. Hence true as second parameter.
          const dependency = this._ensureIsSyncedById(
            doc.space,
            value.cell,
            true,
          );
          dependencies.add(dependency);
          return { ...value, cell: dependency };
        } else {
          console.warn("unexpected doc link", value);
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

    // Make sure the source doc is loaded, and add it as a dependency
    const newValue: { value: any; source?: DocImpl<any> } = {
      value: traverse(value),
    };

    if (source) {
      const sourceDoc = this._ensureIsSyncedById(doc.space, source, true);
      dependencies.add(sourceDoc);
      newValue.source = sourceDoc;
    }

    if (
      JSON.stringify(newValue) !== JSON.stringify(this.readValues.get(doc))
    ) {
      this.readDependentDocs.set(doc, dependencies);
      this.readValues.set(doc, newValue);

      this._addToBatch([{ doc, type: "doc" }]);
    }
  }

  // Processes the current batch, returns final operations to apply all at once
  // while clearing the batch.
  //
  // In a loop will:
  // - For all loaded docs, collect dependencies and add those to list of docs
  // - Await loading of all remaining docs, then add read/write to batch,
  //   install listeners, resolve loading promise
  // - Once no docs are left to load, convert batch jobs to ops by copying over
  //   the current values
  //
  // An invariant we can use: If a doc is loaded and _not_ in the batch, then
  // it is current, and we don't need to verify it's dependencies. That's
  // because once a doc is loaded, updates come in via listeners only, and they
  // add entries to tbe batch.
  private async _processCurrentBatch(): Promise<void> {
    const loading = new Set<DocImpl<any>>();
    const loadedDocs = new Set<DocImpl<any>>();

    log(() => [
      "processing batch",
      this.currentBatch.map(({ doc, type }) =>
        `${JSON.stringify(doc.entityId)}:${type}`
      ),
    ]);

    do {
      // Load everything in loading
      const loaded = await Promise.all(
        Array.from(loading).map((doc) => this.loadingPromises.get(doc)!),
      );
      if (loading.size === 0) {
        // If there was nothing queued, let the event loop settle before
        // continuing. We might have gotten new data from storage.
        await new Promise((r) => setTimeout(r, 0));
      }
      loading.clear();

      for (const doc of loaded) {
        loadedDocs.add(doc);

        // After first load, we set up sync: If storage doesn't know about the
        // doc, we need to persist the current value. If it does, we need to
        // update the doc value.
        const value = this._getStorageProviderForSpace(doc.space).get(
          doc.entityId!,
        );
        if (value === undefined) this._batchForStorage(doc);
        else this._batchForDoc(doc, value.value, value.source);

        // From now on, we'll get updates via listeners
        this._subscribeToChanges(doc);
      }

      // For each entry in the batch, find all dependent not yet loaded docs.
      // Note that this includes both docs just added above, after loading and
      // docs that were updated in the meantime and possibly gained
      // dependencies.
      for (const { doc, type } of this.currentBatch) {
        if (type === "sync") {
          if (this.docIsLoading.has(doc) && !loadedDocs.has(doc)) {
            loading.add(doc);
          }
        } else {
          // Invariant: Jobs with "doc" or "storage" type are already loaded.
          // But dependencies might change, even while this loop is running.
          const dependentDocs = type === "doc"
            ? this.readDependentDocs.get(doc)
            : this.writeDependentDocs.get(doc);
          log(() => [
            "dependent docs",
            JSON.stringify(doc.entityId),
            [...dependentDocs!].map((c) => JSON.stringify(c.entityId)),
          ]);
          if (dependentDocs) {
            Array.from(dependentDocs)
              .filter(
                (dependent) =>
                  this.docIsLoading.has(dependent) &&
                  !loadedDocs.has(dependent),
              )
              .forEach((dependent) => loading.add(dependent));
          }
        }
      }
      log(
        () => ["loading", [...loading].map((c) => JSON.stringify(c.entityId))],
      );
      log(() => [
        "docIsLoading",
        [...this.docIsLoading.keys()].map((c) => JSON.stringify(c.entityId)),
      ]);
      log(() => [
        "currentBatch",
        this.currentBatch.map(({ doc, type }) =>
          `${JSON.stringify(doc.entityId)}:${type}`
        ),
      ]);
    } while (loading.size > 0);

    // Convert batch jobs to operations:
    const docJobs = new Map(
      this.currentBatch
        .filter(({ type }) => type === "doc")
        .map(({ doc }) => [doc, this.readValues.get(doc)!]),
    );
    const storageJobs = new Map(
      this.currentBatch
        .filter(({ type }) => type === "storage")
        .map(({ doc }) => [doc, this.writeValues.get(doc)!]),
    );

    // Reset batch: Everything coming in now will be processed in the next round
    const currentResolve = this.currentBatchResolve;
    this.currentBatch = [];
    this.currentBatchPromise = new Promise((
      r,
    ) => (this.currentBatchResolve = r));

    // Don't update docs while they might be updating.
    await idle();

    // Storage jobs override doc jobs. Write remaining doc jobs to doc.
    docJobs.forEach(({ value, source }, doc) => {
      // TODO(seefeld): For frozen docs, show a warning if content is different.
      // But also, we should serialize the fact that it is frozen to begin with...
      if (!storageJobs.has(doc) && !doc.isFrozen()) {
        if (source) doc.sourceCell = source;

        log(
          () => [
            "send to doc",
            JSON.stringify(doc.entityId),
            JSON.stringify(value),
          ],
        );
        doc.send(value);
      }
    });

    // Sort storage jobs by space
    const storageJobsBySpace = new Map<
      string,
      { entityId: EntityId; value: any }[]
    >();
    storageJobs.forEach((value, doc) => {
      const space = doc.space;
      if (!storageJobsBySpace.has(space)) storageJobsBySpace.set(space, []);
      storageJobsBySpace.get(space)!.push({ entityId: doc.entityId!, value });
    });

    // Write all storage jobs to storage, in parallel
    await Promise.all(
      Array.from(storageJobsBySpace.keys()).map((space) =>
        this._getStorageProviderForSpace(space).send(
          storageJobsBySpace.get(space)!.map(({ entityId, value }) => ({
            entityId,
            value,
          })),
        )
      ),
    );

    // Finally, clear and resolve loading promise for all loaded cells
    for (const doc of loadedDocs) {
      const resolve = this.loadingResolves.get(doc);
      this.loadingPromises.delete(doc);
      this.docIsLoading.delete(doc);
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
      const now = Date.now();

      // Check if we're processing batches too rapidly
      const timeSinceLastBatch = now - this.lastBatchTime;
      const needsDebounce = timeSinceLastBatch < 100;

      const executeTask = () => {
        this.batchStartTime = Date.now();
        this._processCurrentBatch().then(() => {
          this.currentBatchProcessing = false;
          this.lastBatchTime = Date.now(); // Record when batch finished

          // If more items accumulated during processing, schedule the next batch
          if (this.currentBatch.length > 0) {
            // Pass empty array to signal this is a continuation
            this._addToBatch([]);
          }
        });
      };

      if (needsDebounce) {
        // Increase debounce count (capped at 17)
        if (this.lastBatchDebounceCount < 17) this.lastBatchDebounceCount++;

        // First 10 have no delay, then exponential: 50, 100, 200, 400, ..., 1600
        const exp = Math.max(0, this.lastBatchDebounceCount - 10) ** 2;
        const delay = 50 * exp * (1 + Math.random());

        if (delay > 1000) console.warn(`debouncing by ${delay}ms`);

        // Set timeout to execute the batch after delay
        this.debounceTimeout = setTimeout(executeTask, delay);
      } else {
        // Reset counter if we're not debouncing
        this.lastBatchDebounceCount = 0;
        queueMicrotask(executeTask);
      }
    }

    return this.currentBatchPromise;
  }

  private _subscribeToChanges(doc: DocImpl<any>): void {
    log(() => ["subscribe to changes", JSON.stringify(doc.entityId)]);

    // Subscribe to doc changes, send updates to storage
    this.addCancel(
      doc.updates((value) => {
        log(
          () => [
            "got from doc",
            JSON.stringify(doc.entityId),
            JSON.stringify(value),
          ],
        );
        return this._batchForStorage(doc);
      }),
    );

    // Subscribe to storage updates, send results to doc
    this.addCancel(
      this._getStorageProviderForSpace(doc.space).sink(
        doc.entityId!,
        (value) => this._batchForDoc(doc, value.value, value.source),
      ),
    );
  }
}

export const storage = new StorageImpl();
