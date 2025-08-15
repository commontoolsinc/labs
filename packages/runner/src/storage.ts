import { refer } from "merkle-reference";
import { Immutable, isRecord } from "@commontools/utils/types";
import type {
  JSONValue,
  MemorySpace,
  SchemaContext,
  SchemaPathSelector,
} from "@commontools/memory/interface";
import type { BaseMemoryAddress } from "@commontools/runner/traverse";
import { getLogger } from "@commontools/utils/logger";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import { type Cell, isCell } from "./cell.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import type {
  IExtendedStorageTransaction,
  IStorageManager,
  IStorageProvider,
  IStorageSubscription,
  Labels,
  StorageNotification,
  StorageValue,
  URI,
} from "./storage/interface.ts";
import type { IRuntime, IStorage } from "./runtime.ts";
import { DocObjectManager, querySchema } from "./storage/query.ts";
import { deepEqual } from "./path-utils.ts";
import {
  getCellOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { isLink } from "./link-utils.ts";
import {
  ExtendedStorageTransaction,
  ShimStorageManager,
} from "./storage/transaction-shim.ts";
import type { EntityId } from "./doc-map.ts";
export type { Labels, MemorySpace };

const logger = getLogger("storage", { enabled: false, level: "debug" });

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
  private storageProviders = new Map<string, IStorageProvider>();

  // Any doc here is being synced or in the process of spinning up syncing.
  private loadingPromises = new Map<string, Promise<Cell<any>>>();
  // Resolves for the promises above.
  private loadingResolves = new Map<string, (doc: Cell<any>) => void>();

  // We'll also keep track of the subscriptions for the docs.
  // These don't care about schema, and use the combination of the space and
  // uri as the key.
  private storageToDocSubs = new Map<string, Cancel>();
  private docToStorageSubs = new Map<string, Cancel>();

  // Tracks promises returned by storage updates.
  private docToStoragePromises = new Set<Promise<any>>();
  // Track the docs that have changes that need to be sent.
  // They will be removed from here as soon as we call send, but they will
  // still be in the docToStoragePromises until the send returns.
  private dirtyDocs = new Set<string>();
  // Track active _updateDoc operations to prevent race conditions
  private activeUpdateFromStorageCount = 0;
  private updateFromStoragePromise: Promise<void> | undefined;
  private _updateFromStorageResolver: (() => void) | undefined;

  private shimStorageManager: ShimStorageManager | undefined;

  private cancel: Cancel;
  private addCancel: AddCancel;

  constructor(
    readonly runtime: IRuntime,
    private readonly storageManager: IStorageManager,
    private readonly useStorageManagerTransactions: boolean,
  ) {
    const [cancel, addCancel] = useCancelGroup();
    this.cancel = cancel;
    this.addCancel = addCancel;

    if (!this.useStorageManagerTransactions) {
      this.shimStorageManager = new ShimStorageManager(this.runtime);
    }
  }

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IExtendedStorageTransaction {
    // Use transaction API from storage manager if enabled, otherwise
    // use a shim.
    const transaction = this.useStorageManagerTransactions
      ? this.storageManager.edit()
      : this.shimStorageManager!.edit();

    return new ExtendedStorageTransaction(transaction);
  }

  /**
   * Subscribe to storage notifications.
   *
   * @param subscription - The subscription to subscribe to.
   */
  subscribe(subscription: IStorageSubscription) {
    if (this.useStorageManagerTransactions) {
      this.storageManager.subscribe(subscription);
    } else {
      this.shimStorageManager!.subscribe(subscription);
    }
  }

  shimNotifySubscribers(notification: StorageNotification) {
    this.shimStorageManager?.notifySubscribers(notification);
  }

  get shim(): boolean {
    return !this.useStorageManagerTransactions;
  }

  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * TODO(seefeld): Should this return a `Cell` instead? Or just an empty promise?
   */
  async syncCell<T = any>(
    cell: Cell<any>,
    expectedInStorage?: boolean,
    schemaContext?: SchemaContext,
  ): Promise<Cell<T>> {
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
    const selector = schemaContext === undefined ? undefined : {
      path: cell.path.map((p) => p.toString()),
      schemaContext,
    };

    if (!this.shim) {
      const { space, id } = cell.getAsNormalizedFullLink();
      const storageProvider = this._getStorageProviderForSpace(space);
      await storageProvider.sync(id, selector);
      return cell;
    }

    const doc = cell.getDoc();
    if (!isDoc(doc)) {
      throw new Error("Invalid subject: " + JSON.stringify(doc));
    }
    if (!doc.entityId) throw new Error("Doc has no entity ID");

    // If the doc is ephemeral, we don't need to load it from storage. We still
    // add it to the map of known docs, so that we don't try to keep loading
    // it.
    if (doc.ephemeral) return cell;

    const syncKey = Storage._getSyncKey(doc, schemaContext);
    // If the doc/schema pair is already loading, await that promise
    if (this.loadingPromises.has(syncKey)) {
      return this.loadingPromises.get(syncKey)!;
    }

    // Set up a promise, so that we can notify other syncCell callers when our
    // results are ready.
    const { promise, resolve } = Promise.withResolvers<Cell<T>>();
    this.loadingPromises.set(syncKey, promise);
    this.loadingResolves.set(syncKey, resolve);

    // Start loading the doc and save the promise so we don't have more than one
    // caller loading this doc.
    const storageProvider = this._getStorageProviderForSpace(doc.space);
    const uri = Storage.toURI(doc.entityId);

    const result = await storageProvider.sync(uri, selector);
    if (result.error) {
      // This will be a decoupled doc that is not persisted and cannot be edited
      doc.ephemeral = true;
      doc.freeze("loading error");
    } else {
      await this._integrateResult(doc, storageProvider, schemaContext);
    }
    this.loadingResolves.get(syncKey)?.(cell);
    this.loadingResolves.delete(syncKey);
    this.loadingPromises.delete(syncKey);
    return cell;
  }

  async synced(): Promise<void> {
    if (!this.shim) {
      return this.storageManager.synced();
    }

    await Promise.all([
      ...this.loadingPromises.values(),
      ...this.docToStoragePromises.values(),
    ]);
    return;
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      Array.from(this.storageProviders.values()).map((provider) =>
        provider.destroy()
      ),
    );
    this.loadingPromises.clear();
    this.loadingResolves.clear();
    this.storageToDocSubs.clear();
    this.docToStorageSubs.clear();
    this.docToStoragePromises.clear();
    this.dirtyDocs.clear();
    this.activeUpdateFromStorageCount = 0;
    this.updateFromStoragePromise = undefined;
    this._updateFromStorageResolver = undefined;
    this.cancel();
  }

  private _getStorageProviderForSpace(space: MemorySpace): IStorageProvider {
    if (!space) throw new Error("No space set");

    let provider = this.storageProviders.get(space);

    if (!provider) {
      provider = this.storageManager.open(space);
      this.storageProviders.set(space, provider);
    }
    return provider;
  }

  // Given a doc and a schema context, return a string that can be used as a map key
  private static _getSyncKey(doc: DocImpl<any>, schemaContext?: SchemaContext) {
    // I use SchemaPathSelector here instead of just SchemaContext because
    // it's the more general way to load a doc.
    const selector: SchemaPathSelector = {
      path: [],
      schemaContext: schemaContext,
    };
    const selectorRef = refer(JSON.stringify(selector)).toString();
    const docId = Storage.toURI(doc.entityId);
    return `${doc.space}/${docId}/application/json?${selectorRef}`;
  }

  // After attempting to load the relevant documents from storage, we can
  // create any docs needed, and tie the storage and doc together.
  private async _integrateResult<T>(
    doc: DocImpl<T>,
    storageProvider: IStorageProvider,
    schemaContext?: SchemaContext,
  ): Promise<URI[]> {
    // Don't update docs while they might be updating.
    await this.runtime.scheduler.idle();
    // Don't update docs while we have pending writes to storage
    await Promise.all(this.docToStoragePromises);

    // Run a schema query against our local content, so we can either send
    // the set of linked docs, or load them.
    const uri = Storage.toURI(doc.entityId);
    const { missing, loaded } = this._queryLocal(
      doc.space,
      uri,
      storageProvider,
      schemaContext,
    );
    // Ignore any entries that aren't json. We typically have the
    // per-space transaction entry, and may have labels.
    // We'll also ensure we're only dealing with the entity ids that will
    // be managed in our document map.
    const uris = loaded.values().map((valueEntry) => valueEntry.source)
      .filter((docAddr) =>
        docAddr.type === "application/json" && docAddr.id.startsWith("of:")
      ).map((docAddr) => docAddr.id).toArray();

    // It's ok to be missing the primary record (this is the case when we are
    // creating it for the first time).
    if (
      missing.length === 1 &&
      missing[0].id === uri
    ) {
      uris.push(missing[0].id);
      // } else if (missing.length > 1) {
      //   console.debug("missing", missing);
    }

    const docMap = this.runtime.documentMap;
    // First, make sure we have all these docs in the runtime document map
    // This should also handle the source docs, since they will be included
    // in our query result.
    for (const uri of uris) {
      docMap.getDocByEntityId(doc.space, uri, true);
    }
    // Any objects that aren't on the server may need to be sent there.
    const valuesToSend: { uri: URI; value: StorageValue<JSONValue> }[] = [];
    // Now make another pass. At this point, we can leave any docs that aren't
    // in the DocumentMap alone, but set the cell to the DocImpl for the ones
    // that are present.
    // This does not preserve any dependency order like the topological sort
    // does, but I don't think we need to do this anymore.
    // I use the storage provider to get the nursery version if it's more recent.
    // This makes it so if I have local changes, they aren't lost.
    for (const uri of uris) {
      const storageValue = storageProvider.get<JSONValue>(uri);
      const newDoc = docMap.getDocByEntityId(doc.space, uri, false)!;
      // We don't need to hook up ephemeral docs
      if (newDoc.ephemeral) {
        logger.info(
          () => [
            "Found link to ephemeral doc",
            uri,
            "from",
            Storage.toURI(doc.entityId),
          ],
        );
        continue;
      }
      // NOTE(@ubik2): I can't recall if a retraction will come over as a missing isValue.
      // We may still be doing the "value" wrapping in the network protocol, even though
      // that's not what they look like on the server. Not urgent, since we don't do
      // retractions right now.
      // TODO(@ubik2): this shares too much logic with the functions in
      // _subscribeToChanges
      const docValue = Storage._cellLinkToJSON(newDoc);
      if (storageValue !== undefined) {
        // The object exists on the server, so push its value to the doc
        // unless we already have the same contents.
        if (!deepEqual(storageValue.value, docValue.value)) {
          // Copy the value in storage to the doc
          const newValue = JSON.parse(JSON.stringify(storageValue.value));
          newDoc.send(newValue);
        }
        // We can only set the source if it hasn't been set
        if (
          storageValue.source !== undefined && newDoc.sourceCell === undefined
        ) {
          newDoc.sourceCell = this.runtime.documentMap.getDocByEntityId(
            doc.space,
            storageValue.source,
            false,
          );
          if (newDoc.sourceCell === undefined) {
            console.warn("Failed to set source cell");
          }
        }
      } else {
        // The object doesn't exist in storage, but it does in the doc map
        // TODO(@ubik2): investigate labels
        // Copy the value in doc for storage, and add to the set of writes
        valuesToSend.push({ uri: uri, value: docValue });
      }

      // Any updates to these docs should be sent to storage, and any update
      // in storage should be used to update these docs.
      this._subscribeToChanges(newDoc);
    }
    if (valuesToSend.length > 0) {
      // Don't worry about redundant sends, since the provider handles that.
      const result = await storageProvider.send(valuesToSend);
      if (result.error) {
        console.warn("Failed to write objects");
        return [];
      }
    }
    return uris;
  }
  // We need to call this for all the docs that will be part of this transaction
  // This goes through the document and converts the DocImpls in CellLink objects
  // to plain JSON links instead.
  private static _cellLinkToJSON<T>(
    doc: DocImpl<T>,
    labels?: Labels,
  ): StorageValue<JSONValue> {
    // Traverse the value and for each doc reference, make sure it's
    // converted to JSON. This is done recursively.
    const traverse = (
      value: Readonly<any>,
    ): JSONValue => {
      // If it's a doc, make it a doc link -- we'll swap this for json below
      if (isLink(value)) {
        // Don't convert to sigil link here, as we plan to remove this whole
        // transformation soon. So return value instead of creating a sigil
        // link. Roundtripping through JSON converts all Cells and Docs to a
        // serializable format.
        if (isQueryResultForDereferencing(value)) {
          value = getCellOrThrow(value);
        }
        return JSON.parse(JSON.stringify(value));
      } else if (isRecord(value)) {
        if (Array.isArray(value)) {
          return value.map((val) => traverse(val));
        } else {
          return Object.fromEntries(
            Object.entries(value).map(([key, val]: [PropertyKey, any]) => [
              key.toString(),
              traverse(val),
            ]),
          );
        }
      } else return value;
    };

    // Convert all doc references to ids and remember as dependent docs
    const newValue: StorageValue<JSONValue> = {
      value: traverse(doc.get() as Immutable<any>),
      ...(doc.sourceCell?.entityId !== undefined)
        ? { source: doc.sourceCell.entityId }
        : {},
      ...(labels !== undefined) ? { labels: labels } : {},
    };

    return newValue;
  }

  // Run a query locally against either the docmap or the storageprovider
  // We use a default schemaContext of true to behave like the old style
  // full traversal when we don't have a schema.
  private _queryLocal(
    space: MemorySpace,
    uri: URI,
    storageProvider: IStorageProvider,
    schemaContext: SchemaContext = { schema: true, rootSchema: true },
  ) {
    const manager = new DocObjectManager(
      space,
      storageProvider,
      this.runtime.documentMap,
      Storage._cellLinkToJSON,
    );
    const docAddress = { id: uri, type: "application/json" };
    const selector = { path: [], schemaContext: schemaContext };
    return querySchema(selector, [], docAddress, manager);
  }

  // Update storage with the new doc value
  private _updateStorage(
    doc: DocImpl<any>,
    value: StorageValue<JSONValue | undefined>,
    labels: Labels | undefined,
  ) {
    logger.debug(
      () => [
        "got from doc",
        JSON.stringify(doc.entityId),
        JSON.stringify(value),
      ],
    );
    const uri = Storage.toURI(doc.entityId);
    const storageValue = Storage._cellLinkToJSON(doc, labels);
    const existingValue = this._getStorageProviderForSpace(doc.space).get<
      JSONValue
    >(uri);
    // If our value is the same as what storage has, we don't need to do anything.
    if (deepEqual(storageValue, existingValue)) {
      return;
    }

    // If we're already dirty, we don't need to add a promise
    const docKey = `${doc.space}/${uri}`;
    if (this.dirtyDocs.has(docKey)) {
      return;
    }
    this.dirtyDocs.add(docKey);

    // Track these promises for our synced call.
    // We may have linked docs that storage doesn't know about
    const storageProvider = this._getStorageProviderForSpace(doc.space);
    const { missing, loaded } = this._queryLocal(
      doc.space,
      uri,
      storageProvider,
    );
    // Any missing docs need to be linked up
    for (const factAddress of missing) {
      // missing docs have been created in our doc map, but storage doesn't
      // know anything about them.
      // TODO(@ubik2) I've lost the schema here
      const linkedDoc = this.runtime.documentMap.getDocByEntityId(
        doc.space,
        factAddress.id,
      );
      logger.info(() => ["calling sync cell on missing doc", factAddress.id]);
      // We do need to call syncCell, because we may have pushed a new cell
      // without calling syncCell (e.g. map will create these cells).
      // I can modify the DocImpl class to automatically relay the doc updates
      // to storage, but I also need to have storage update the docs.
      // We don't need to await this, since by the time we've resolved our
      // docToStoragePromise, we'll have added the loadingPromise.
      // Not awaiting means that the cache may need to pull before push,
      // and that can re-order writes.
      this.syncCell(linkedDoc.asCell());
    }
    // Our queryLocal call has determined which docs are linked, so make sure
    // we're sending those to storage as well. If they're redundant, they will
    // be skipped by storage.
    const docAddrs = [...missing, ...loaded.values().map((sv) => sv.source)];
    const docToStoragePromise = this._sendDocValue(doc, docAddrs, labels);
    this.docToStoragePromises.add(docToStoragePromise);
    docToStoragePromise.finally(() =>
      this.docToStoragePromises.delete(docToStoragePromise)
    );
  }

  private async _sendDocValue(
    doc: DocImpl<unknown>,
    docAddrs: BaseMemoryAddress[],
    labels?: Labels,
  ) {
    await this.runtime.idle();

    // Wait for all _updateDoc operations to complete, then wait for runtime to
    // be idle again. Since more updates might have come in in the meantime,
    // wait again. Repeat until the incoming queue is empty and the runtime is
    // settled.
    while (this.updateFromStoragePromise) {
      await this.updateFromStoragePromise;
      await this.runtime.idle();
    }

    const uri = Storage.toURI(doc.entityId);
    const docKey = `${doc.space}/${uri}`;
    // We remove the main doc from the dirty list, but not the others
    // They can handle that in their own sync
    this.dirtyDocs.delete(docKey);

    const storageProvider = this._getStorageProviderForSpace(doc.space);

    const docsToSend = [];
    for (const docAddr of docAddrs) {
      const linkedDoc = this.runtime.documentMap.getDocByEntityId(
        doc.space,
        docAddr.id,
        false,
      );
      // if we don't have a local doc, the server's version should be fine
      if (linkedDoc === undefined) {
        continue;
      }
      // The main doc can tell us about the labels applied based on the schema,
      // but we aren't carrying that through queryLocal, so we don't know for
      // other docs.
      // Also, the doc itself could be associated with multiple schemas.
      // This is just the one that we used when we wrote this value to the doc.
      const linkedLabels = linkedDoc === doc ? labels : undefined;
      // Create storage value using the helper to ensure consistency
      const linkedValue = Storage._cellLinkToJSON(linkedDoc, linkedLabels);
      docsToSend.push({ uri: docAddr.id, value: linkedValue });
    }
    await storageProvider.send(docsToSend);
  }

  // Update the doc with the new value we got in storage.
  private async _updateDoc(
    doc: DocImpl<JSONValue>,
    storageValue: StorageValue<JSONValue>,
  ) {
    // Increment the counter at the start
    this.activeUpdateFromStorageCount++;

    // Create or update the promise if this is the first update
    if (this.activeUpdateFromStorageCount === 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.updateFromStoragePromise = promise;
      // Store the resolver to call when count reaches 0
      this._updateFromStorageResolver = resolve;
    }

    try {
      // Don't update docs while they might be updating.
      await this.runtime.idle();

      if (!deepEqual(storageValue.value, doc.get())) {
        // values differ
        const newDocValue = JSON.parse(JSON.stringify(storageValue.value));
        doc.send(newDocValue);
      }
      const newSourceCell = (storageValue.source !== undefined)
        ? this.runtime.documentMap.getDocByEntityId(
          doc.space,
          storageValue.source,
          false,
        )
        : undefined;
      if (doc.sourceCell !== newSourceCell) {
        doc.sourceCell = newSourceCell;
      }
    } finally {
      // Decrement the counter
      this.activeUpdateFromStorageCount--;

      // If this was the last update, resolve the promise
      if (
        this.activeUpdateFromStorageCount === 0 && this.updateFromStoragePromise
      ) {
        const resolver = this._updateFromStorageResolver;
        if (resolver) {
          resolver();
        }
        this.updateFromStoragePromise = undefined;
        this._updateFromStorageResolver = undefined;
      }
    }
  }

  private _subscribeToChanges(doc: DocImpl<any>): void {
    logger.debug(() => ["subscribe to changes", JSON.stringify(doc.entityId)]);

    const uri = Storage.toURI(doc.entityId);
    const docKey = `${doc.space}/${uri}`;

    // Clear any existing subscriptions first - we only want one callback
    // and if we call syncCell multiple times, we would end up
    // with multiple subscriptions.
    if (this.docToStorageSubs.has(docKey)) {
      // Cancel any existing subscription
      this.docToStorageSubs.get(docKey)?.();
      this.docToStorageSubs.delete(docKey);
    }
    if (this.storageToDocSubs.has(docKey)) {
      // Cancel any existing subscription
      this.storageToDocSubs.get(docKey)?.();
      this.storageToDocSubs.delete(docKey);
    }

    // Subscribe to doc changes, send updates to storage
    const docToStorage = doc.updates((value, _path, labels) =>
      this._updateStorage(doc, value, labels)
    );
    this.addCancel(docToStorage);
    this.docToStorageSubs.set(docKey, docToStorage);

    // This will be called when we get an update from the server,
    // and merge the changes into the heap.
    const storageToDoc = this._getStorageProviderForSpace(doc.space).sink<
      JSONValue
    >(uri, async (storageValue) => await this._updateDoc(doc, storageValue));
    this.addCancel(storageToDoc);
    this.storageToDocSubs.set(docKey, storageToDoc);
  }

  static toURI(source: EntityId): URI {
    if (typeof source["/"] === "string") {
      return `of:${source["/"]}`;
    } else if (source.toJSON) {
      return `of:${source.toJSON()["/"]}`;
    } else {
      throw Object.assign(
        new TypeError(
          `💣 Got entity ID that is neither merkle reference nor {'/'}`,
        ),
        {
          cause: source,
        },
      );
    }
  }
}
