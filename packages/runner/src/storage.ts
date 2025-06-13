import { isRecord } from "@commontools/utils/types";
import { defer } from "@commontools/utils/defer";
import { sleep } from "@commontools/utils/sleep";
import { Signer } from "@commontools/identity";
import { type SchemaContext } from "@commontools/builder";
import { type TransactionResult } from "@commontools/memory";
import { refer } from "@commontools/memory/reference";
import { MemorySpace, SchemaNone } from "@commontools/memory/interface";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import { Cell, type CellLink, isCell, isCellLink, isStream } from "./cell.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type EntityId, getEntityId } from "./doc-map.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import {
  BaseStorageProvider,
  type Labels,
  StorageProvider,
  StorageValue,
} from "./storage/base.ts";
import { log } from "./log.ts";
import { Provider as CachedStorageProvider } from "./storage/cache.ts";
import { VolatileStorageProvider } from "./storage/volatile.ts";
import type { IRuntime, IStorage } from "./runtime.ts";

export type { Labels };

type Job = {
  doc: DocImpl<any>;
  type: "doc" | "storage" | "sync";
  label?: string;
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
export class Storage implements IStorage {
  // Map from space to storage provider. TODO(seefeld): Push spaces to storage
  // providers.
  private storageProviders = new Map<string, StorageProvider>();
  private remoteStorageUrl: URL | undefined;
  private signer: Signer | undefined;

  // Any doc here is being synced or in the process of spinning up syncing. See
  // also docIsLoading, which is a promise while the document is loading, and is
  // deleted after it is loaded.
  //
  // FIXME(@ubik2) All four of these should probably be keyed by a combination
  // of a doc and a schema If we load the same entity with different schemas, we
  // want to track their resolution differently. If we only use one schema per
  // doc, this will work ok.
  private docIsSyncing = new Set<DocImpl<any>>();

  // Map from doc to promise of loading doc, set at stage 2. Resolves when
  // doc and all it's dependencies are loaded.
  private docIsLoading = new Map<DocImpl<any>, Promise<DocImpl<any>>>();

  // Resolves for the promises above. Only called by batch processor.
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
  private currentBatchResolve: (() => void) | undefined;
  private currentBatchPromise: Promise<void> = Promise.resolve();
  private lastBatchTime: number = 0;
  private lastBatchDebounceCount: number = 0;

  private cancel: Cancel;
  private addCancel: AddCancel;

  constructor(
    readonly runtime: IRuntime,
    options: {
      remoteStorageUrl: URL;
      signer?: Signer;
    },
  ) {
    const [cancel, addCancel] = useCancelGroup();
    this.cancel = cancel;
    this.addCancel = addCancel;

    // Set configuration from constructor options
    this.remoteStorageUrl = options.remoteStorageUrl;

    if (options.signer) this.signer = options.signer;
  }

  setSigner(signer: Signer): void {
    this.signer = signer;
  }

  hasSigner(): boolean {
    return this.signer !== undefined;
  }

  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * TODO(seefeld): Should this return a `Cell` instead? Or just an empty promise?
   */
  syncCell<T = any>(
    cell: DocImpl<T> | Cell<any>,
    expectedInStorage?: boolean,
    schemaContext?: SchemaContext,
  ): Promise<DocImpl<T>> | DocImpl<T> {
    // If we aren't overriding the schema context, and we have a schema in the cell, use that
    if (
      schemaContext === undefined && isCell(cell) &&
      cell.schema !== undefined
    ) {
      schemaContext = {
        schema: cell.schema,
        rootSchema: (cell.rootSchema !== undefined)
          ? cell.rootSchema
          : cell.schema,
      };
    }

    const entityDoc = this._ensureIsSynced(
      cell,
      expectedInStorage,
      schemaContext,
    );

    // If doc is loading, return the promise. Otherwise return immediately.
    return this.docIsLoading.get(entityDoc) ?? entityDoc;
  }

  synced(): Promise<void> {
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

  private _getStorageProviderForSpace(space: string): StorageProvider {
    if (!space) throw new Error("No space set");

    let provider = this.storageProviders.get(space);

    if (!provider) {
      // Default to "schema", but let either custom URL (used in tests) or
      // environment variable override this.
      const type = this.remoteStorageUrl?.protocol === "volatile:"
        ? "volatile"
        : ((import.meta as any).env?.VITE_STORAGE_TYPE ?? "schema");

      if (type === "volatile") {
        provider = new VolatileStorageProvider(space);
      } else if (type === "schema" || type === "cached") {
        if (!this.remoteStorageUrl) {
          throw new Error("No remote storage URL set");
        }
        if (!this.signer) {
          throw new Error("No signer set for schema storage");
        }
        const settings = {
          maxSubscriptionsPerSpace: 50_000,
          connectionTimeout: 30_000,
          useSchemaQueries: type === "schema",
        };
        provider = new CachedStorageProvider({
          id: this.runtime.id,
          address: new URL("/api/storage/memory", this.remoteStorageUrl!),
          space: space as `did:${string}:${string}`,
          as: this.signer,
          settings: settings,
        });
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
    schemaContext?: SchemaContext,
  ): DocImpl<T> {
    return this._ensureIsSynced(
      this.runtime.documentMap.getDocByEntityId<T>(space, id, true)!,
      expectedInStorage,
      schemaContext,
    );
  }

  private _ensureIsSynced<T>(
    doc: DocImpl<T> | Cell<any>,
    expectedInStorage: boolean = false,
    schemaContext?: SchemaContext,
  ): DocImpl<T> {
    if (isCell(doc) || isStream(doc)) doc = doc.getDoc();
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

    console.log("Called _ensureIsSynced for", JSON.stringify(doc.entityId));
    // Start loading the doc and safe the promise for processBatch to await for
    const loadingPromise = this._getStorageProviderForSpace(doc.space)
      .sync(doc.entityId!, expectedInStorage, schemaContext)
      .then((result) => {
        if (result.error) {
          console.log("got result error", result.error);
          // This will be a decoupled doc that is not persisted and cannot be edited
          doc.ephemeral = true;
          doc.freeze();
        } else {
          console.log("Sync of", JSON.stringify(doc.entityId), "completed");
          // at ths point, the storage provider has the right value, but it hasn't been set in doc
          console.log(result.ok as any);
        }
        return doc;
      });
    this.loadingPromises.set(doc, loadingPromise);

    // Create a promise that gets resolved once the doc and all its
    // dependencies are loaded. It'll return the doc when done.
    const { promise, resolve } = defer<void, Error>();
    this.loadingResolves.set(doc, resolve);
    this.docIsLoading.set(doc, promise.then(() => doc));

    // If we needed privilege to get this doc, we likely need it for included docs
    const lubLabel = schemaContext === undefined
      ? undefined
      : this.runtime.cfc.lubSchema(schemaContext.schema);
    this._addToBatch([{ doc: doc, type: "sync", label: lubLabel }]);

    // Return the doc, to make calls chainable.
    return doc;
  }

  // Prepares value for storage, and updates dependencies, triggering doc loads
  // if necessary. Updates this.writeValues and this.writeDependentDocs.
  private _batchForStorage(doc: DocImpl<any>, labels?: Labels): void {
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
      value: Readonly<any>,
      path: PropertyKey[],
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
      } else if (isRecord(value)) {
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
      ...(labels !== undefined) ? { labels: labels } : {},
    };

    // 🤔 I'm guessing we should be storing schema here
    if (JSON.stringify(value) !== JSON.stringify(this.writeValues.get(doc))) {
      log(() => [
        "prep for storage",
        JSON.stringify(doc.entityId),
        value,
        this.writeValues.get(doc),
        [...dependencies].map((c) => JSON.stringify(c.entityId)),
      ]);
      this.writeDependentDocs.set(doc, dependencies);
      this.writeValues.set(doc, value);

      this._addToBatch([{ doc, type: "storage" }]);
    }
  }

  // Prepares value for docs, and updates dependencies, triggering doc loads
  // if necessary. Updates this.readValues and this.readDependentDocs.
  private _batchForDoc(
    doc: DocImpl<any>,
    value: any,
    source?: EntityId,
    label?: string,
  ): void {
    log(() => [
      "prep for doc",
      JSON.stringify(doc.entityId),
      value,
      JSON.stringify(source ?? null),
    ]);

    const dependencies = new Set<DocImpl<any>>();

    // This will replace any cell links with a DocImpl if we have that
    // doc available. We should already have any docs we need available.
    const traverse = (value: any): any => {
      if (typeof value !== "object" || value === null) {
        return value;
      } else if ("cell" in value && "path" in value) {
        // If we see a doc link with just an id, then we replace it with
        // the actual doc:
        console.log(JSON.stringify(value));
        if (
          isRecord(value.cell) &&
          "/" in value.cell &&
          Array.isArray(value.path)
        ) {
          const entityId = getEntityId(value.cell)!;
          // Any dependent docs that we expected should already be loaded,
          // so we can just grab them from the runtime's document map.
          // If they aren't available, then leave the link in its raw form.
          const dependency = this.getDocFromRuntimeOrStorage(
            doc.space,
            entityId,
          );
          if (dependency !== undefined) {
            dependencies.add(dependency);
            return { ...value, cell: dependency };
          }
          // Previously, we would also call _ensureIsSyncedById to recursively
          // load the docs linked to by this dependency, but now we expect to
          // already have all the docs we need in our Provider. We still need
          // to do the subscription to changes through the Provider, and we
          // still need to connect the dependent docs to the Provider's data.
          return value;
        } else {
          console.warn("unexpected doc link", value);
          return value;
        }
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
      const sourceDoc = this.runtime.documentMap.getDocByEntityId(
        doc.space,
        source,
        false,
      )!;
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

  private getDocFromRuntimeOrStorage(
    space: MemorySpace,
    entityId: { "/": string },
  ) {
    // Any dependent docs that we expected should already be loaded,
    // so we can just grab them from the runtime's document map.
    // If they aren't available, then leave the link in its raw form.
    const dependency = this.runtime.documentMap.getDocByEntityId(
      space,
      entityId,
      false,
    );
    if (dependency !== undefined) {
      // FIXME: I still need to traverse, swapping links as I go, because I
      // may have and old record which did not include some links, and now
      // I have a new record which includes those links. I want to swap in
      // those links.
      return dependency;
    }

    // Check in storage - we may have fetched the doc, but not set it up
    // in our runtime's document map.
    const storageValue = this._getStorageProviderForSpace(space).get(entityId);
    if (storageValue !== undefined) {
      const depDoc = this.runtime.documentMap.getDocByEntityId(
        space,
        entityId,
        true,
      )!;
      // If we hadn't set it up in our document map, we probably need to
      // evaluate this doc's links as well.
      this._batchForDoc(depDoc, storageValue.value, storageValue.source);
      return depDoc;
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
    const loading = new Map<DocImpl<any>, string | undefined>();
    const loadedDocs = new Set<DocImpl<any>>();

    log(() => [
      "processing batch",
      this.currentBatch.map(({ doc, type }) =>
        `${JSON.stringify(doc.entityId)}:${type}`
      ),
    ]);

    do {
      console.log(
        "loading keys",
        loading.keys().map((doc) => JSON.stringify(doc.entityId)),
      );
      // Load everything in loading
      const loaded = await Promise.all(
        Array.from(loading.keys()).map((doc) => this.loadingPromises.get(doc)!),
      );
      if (loading.size === 0) {
        // If there was nothing queued, let the event loop settle before
        // continuing. We might have gotten new data from storage.
        await sleep(0);
      }
      // Keep track of labels we used to load, so we can pass these to our dependent loads
      const loadedLabels = new Map(loading);
      loading.clear();

      for (const doc of loaded) {
        loadedDocs.add(doc);
        const label = loadedLabels.get(doc);
        // After first load, we set up sync: If storage doesn't know about the
        // doc, we need to persist the current value. If it does, we need to
        // update the doc value.
        const value = this._getStorageProviderForSpace(doc.space).get(
          doc.entityId,
        );
        if (value === undefined) this._batchForStorage(doc);
        else this._batchForDoc(doc, value.value, value.source, label);

        // From now on, we'll get updates via listeners
        this._subscribeToChanges(doc);
      }

      // For each entry in the batch, find all dependent not yet loaded docs.
      // Note that this includes both docs just added above, after loading and
      // docs that were updated in the meantime and possibly gained
      // dependencies.
      for (const { doc, type, label } of this.currentBatch) {
        if (type === "sync") {
          if (this.docIsLoading.has(doc) && !loadedDocs.has(doc)) {
            loading.set(doc, label);
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
              .forEach((dependent) => loading.set(dependent, label));
          }
        }
      }
      log(
        () => [
          "loading",
          [...loading.keys()].map((c) => JSON.stringify(c.entityId)),
        ],
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

    // Transfer retry callbacks into this storage job, clear them in the doc
    storageJobs.forEach((value, doc) => {
      if (doc.retry?.length) {
        value.retry = doc.retry;
        doc.retry = [];
      }
    });

    // Reset batch: Everything coming in now will be processed in the next round
    this.currentBatch = [];

    // Don't update docs while they might be updating.
    await this.runtime.scheduler.idle();

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
      { entityId: EntityId; value: StorageValue }[]
    >();
    storageJobs.forEach((value, doc) => {
      const space = doc.space;
      if (!storageJobsBySpace.has(space)) storageJobsBySpace.set(space, []);
      storageJobsBySpace.get(space)!.push({ entityId: doc.entityId!, value });
    });

    log(() => ["storage jobs start"]);

    const process = (
      space: string,
      jobs: { entityId: EntityId; value: StorageValue }[],
    ): Promise<
      { ok: object; err?: undefined } | { ok?: undefined; err?: Error }
    > => {
      const storage = this._getStorageProviderForSpace(space);

      // This is a violating abstractions as it's specific to remote storage.
      // Most of storage.ts should eventually be refactored away between what
      // docs do and remote storage does.
      //
      // Also, this is a hacky version to do retries, and what we instead want
      // is a coherent concept of a transaction across the stack, all the way
      // to scheduler, tied to events, etc. and then retry logic will happen
      // at that level.
      //
      // So consider the below a hack to implement transaction retries just
      // for Cell.push, to solve some short term pain around loosing charms
      // when the charm list is being updated.

      const updatesFromRetry: [DocImpl<any>, StorageValue][] = [];
      let retries = 0;
      const retryOnConflict = (
        result: Awaited<ReturnType<typeof storage.send>>,
      ): ReturnType<typeof storage.send> => {
        const txResult = result as Awaited<TransactionResult>;
        if (txResult.error?.name === "ConflictError") {
          const conflict = txResult.error.conflict;

          log(() => ["conflict", conflict]);

          if (retries++ > 100) {
            console.error("too many retries on conflict");
            return Promise.resolve(result);
          }

          // If nothing in the job has a way to retry, give up
          if (!jobs.some((job) => job.value.retry?.length)) {
            return Promise.resolve(result);
          }

          const conflictJobIndex = jobs.findIndex((job) =>
            BaseStorageProvider.toEntity(job.entityId) === conflict.of
          );

          if (conflictJobIndex === -1) {
            console.warn(
              "no conflicting job found. that should not happen.",
              conflict.of,
            );
            return Promise.resolve(result);
          }

          const conflictJob = jobs[conflictJobIndex];

          // If there is no way to retry, give up
          if (conflictJob.value.retry?.length) {
            // Retry with new value
            let newValue: StorageValue =
              conflict.actual?.is as unknown as StorageValue ?? {};

            try {
              // Apply changes again
              conflictJob.value.retry.forEach((retry) => {
                newValue = { ...newValue, value: retry(newValue.value) };
              });

              log(() => ["retry with", newValue]);

              updatesFromRetry.push([
                this.runtime.documentMap.getDocByEntityId(
                  space,
                  conflictJob.entityId,
                )!,
                newValue,
              ]);

              // Replace job with new value
              jobs[conflictJobIndex] = {
                ...conflictJob,
                value: newValue,
              };
            } catch (e) {
              console.error("error applying retry", e);
              return Promise.resolve(result);
            }
          } else {
            // Fallback: Remove offending transaction
            // NOTE: The new value will arrive via subscribeToChanges
            jobs.splice(conflictJobIndex, 1);
          }

          return storage.send(jobs).then((result) => retryOnConflict(result));
        }

        return Promise.resolve(result);
      };

      log(() => ["sending to storage", jobs]);
      return storage.send(jobs).then((result) => retryOnConflict(result))
        .then((result) => {
          if (result.ok) {
            log(() => ["storage ok", JSON.stringify(result.ok, null, 2)]);
            // Apply updates from retry, if transaction ultimately succeeded
            updatesFromRetry.forEach(([doc, value]) =>
              this._batchForDoc(doc, value.value, value.source)
            );
          } else if (result.error) {
            log(() => ["storage error", JSON.stringify(result.error, null, 2)]);
            console.error("storage error", result.error);
          }
          return result;
        });
    };

    // Write all storage jobs to storage, in parallel
    const promiseJobs = [];
    for (const [space, jobs] of storageJobsBySpace.entries()) {
      if (jobs.length) promiseJobs.push(process(space, jobs));
    }
    await Promise.all(promiseJobs);
    log(() => ["storage jobs done"]);

    // Finally, clear and resolve loading promise for all loaded cells
    for (const doc of loadedDocs) {
      log(() => ["resolve loading promise", JSON.stringify(doc.entityId)]);
      this.loadingPromises.delete(doc);
      this.docIsLoading.delete(doc);
      this.loadingResolves.get(doc)?.();
    }
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
   */
  private _addToBatch(batch: Job[]) {
    this.currentBatch.push(...batch);

    if (!this.currentBatchProcessing) {
      ({
        promise: this.currentBatchPromise,
        resolve: this.currentBatchResolve,
      } = defer<void, Error>());

      this._runBatchesUntilSettled();
    }
  }

  private _runBatchesUntilSettled(): void {
    this.currentBatchProcessing = true;

    const now = Date.now();

    // Check if we're processing batches too rapidly
    const timeSinceLastBatch = now - this.lastBatchTime;
    const needsDebounce = timeSinceLastBatch < 100;

    const executeTask = () => {
      this._processCurrentBatch().then(() => {
        this.lastBatchTime = Date.now(); // Record when batch finished

        // If more items accumulated during processing, schedule the next batch
        if (this.currentBatch.length > 0) {
          log(() => ["next batch immediately", this.currentBatch.length]);
          this._runBatchesUntilSettled();
        } else {
          log(() => ["no more items, resolve"]);
          this.currentBatchProcessing = false;
          this.currentBatchResolve?.();
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
      setTimeout(executeTask, delay);
    } else {
      // Reset counter if we're not debouncing
      this.lastBatchDebounceCount = 0;
      queueMicrotask(executeTask);
    }
  }

  private _subscribeToChanges(doc: DocImpl<any>): void {
    log(() => ["subscribe to changes", JSON.stringify(doc.entityId)]);

    // Subscribe to doc changes, send updates to storage
    this.addCancel(
      doc.updates((value, _path, labels) => {
        log(
          () => [
            "got from doc",
            JSON.stringify(doc.entityId),
            JSON.stringify(value),
          ],
        );
        return this._batchForStorage(doc, labels);
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

const SchemaNoneRef = refer(SchemaNone).toString();
