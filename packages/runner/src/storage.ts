import { refer } from "merkle-reference";
import { isRecord } from "@commontools/utils/types";
import { defer } from "@commontools/utils/defer";
import type {
  JSONValue,
  MemorySpace,
  SchemaContext,
  SchemaPathSelector,
} from "@commontools/memory/interface";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import { Cell, isCell, isStream } from "./cell.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type EntityId, entityIdStr } from "./doc-map.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import type {
  IStorageManager,
  IStorageProvider,
  Labels,
  StorageValue,
} from "./storage/interface.ts";
import { log } from "./log.ts";
import type { IRuntime, IStorage } from "./runtime.ts";
import { DocObjectManager, querySchema } from "./storage/query.ts";
import { deepEqual } from "./path-utils.ts";
import { isLink, parseLink } from "./link-utils.ts";
export type { Labels, MemorySpace };

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
  private loadingPromises = new Map<string, Promise<DocImpl<any>>>();
  // Resolves for the promises above.
  private loadingResolves = new Map<string, (doc: DocImpl<any>) => void>();

  // We'll also keep track of the subscriptions for the docs
  // These don't care about schema, and use the id from the entity id
  private storageToDocSubs = new Map<string, Cancel>();
  private docToStorageSubs = new Map<string, Cancel>();

  // Tracks promises returned by storage updates.
  private docToStoragePromises = new Set<Promise<any>>();

  private cancel: Cancel;
  private addCancel: AddCancel;

  constructor(
    readonly runtime: IRuntime,
    private readonly storageManager: IStorageManager,
  ) {
    const [cancel, addCancel] = useCancelGroup();
    this.cancel = cancel;
    this.addCancel = addCancel;
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
  ): Promise<DocImpl<T>> {
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

    return this._syncCellHelper(cell, schemaContext);
  }

  synced(): Promise<void> {
    return Promise.all([
      ...this.loadingPromises.values(),
      ...this.docToStoragePromises.values(),
    ]).then(() => {
      return;
    });
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
    const docId = entityIdStr(doc.entityId);
    return `${docId}/application/json:${selectorRef}`;
  }

  // Replacement for _ensureIsSynced
  private async _syncCellHelper<T>(
    doc: DocImpl<T> | Cell<any>,
    schemaContext?: SchemaContext,
  ): Promise<DocImpl<T>> {
    if (isCell(doc) || isStream(doc)) doc = doc.getDoc();
    if (!isDoc(doc)) {
      throw new Error("Invalid subject: " + JSON.stringify(doc));
    }
    if (!doc.entityId) throw new Error("Doc has no entity ID");

    // If the doc is ephemeral, we don't need to load it from storage. We still
    // add it to the map of known docs, so that we don't try to keep loading
    // it.
    if (doc.ephemeral) return doc;

    const syncKey = Storage._getSyncKey(doc, schemaContext);
    // If the doc/schema pair is already loading, await that promise
    if (this.loadingPromises.has(syncKey)) {
      const loadingPromise = this.loadingPromises.get(syncKey)!;
      return await loadingPromise;
    }

    // Set up a promise, so that we can notify other syncCell callers when our
    // results are ready.
    const { resolve, reject, promise } = defer<DocImpl<T>>();
    this.loadingPromises.set(syncKey, promise);
    this.loadingResolves.set(syncKey, resolve);

    // Start loading the doc and save the promise so we don't have more than one
    // caller loading this doc.
    const storageProvider = this._getStorageProviderForSpace(doc.space);
    const result = await storageProvider.sync(
      doc.entityId!,
      false,
      schemaContext,
    );

    if (result.error) {
      // This will be a decoupled doc that is not persisted and cannot be edited
      doc.ephemeral = true;
      doc.freeze("loading error");
    } else {
      await this._integrateResult(doc, storageProvider, schemaContext);
    }
    this.loadingResolves.get(syncKey)?.(doc);
    this.loadingResolves.delete(syncKey);
    this.loadingPromises.delete(syncKey);
    return doc;
  }

  // After attempting to load the relevant documents from storage, we can
  // create any docs needed, and tie the storage and doc together.
  private async _integrateResult<T>(
    doc: DocImpl<T>,
    storageProvider: IStorageProvider,
    schemaContext?: SchemaContext,
  ): Promise<EntityId[]> {
    // Run a schema query against our local content, so we can either send
    // the set of linked docs, or load them.
    const { missing, loaded, selected } = this._queryLocal(
      doc.space,
      doc.entityId,
      storageProvider,
      schemaContext,
    );
    // Ignore any entries that aren't json. We typically have the
    // per-space transaction entry, and may have labels.
    // We'll also ensure we're only dealing with the entity ids that will
    // be managed in our document map.
    const entityIds = loaded.values().map((valueEntry) => valueEntry.source)
      .filter((docAddr) =>
        docAddr.the === "application/json" && docAddr.of.startsWith("of:")
      ).map((docAddr) => {
        return { "/": docAddr.of.slice(3) };
      }).toArray();

    // It's ok to be missing the primary record (this is the case when we are
    // creating it for the first time).
    if (
      missing.length === 1 &&
      missing[0].of === `of:${entityIdStr(doc.entityId)}`
    ) {
      entityIds.push({ "/": missing[0].of.slice(3) });
      // } else if (missing.length > 1) {
      //   console.debug("missing", missing);
    }

    const docMap = this.runtime.documentMap;
    // First, make sure we have all these docs in the runtime document map
    // This should also handle the source docs, since they will be included
    // in our query result.
    for (const entityId of entityIds) {
      docMap.getDocByEntityId(doc.space, entityId, true)!;
    }
    // Any objects that aren't on the server may need to be sent there.
    const valuesToSend = [];
    // Now make another pass. At this point, we can leave any docs that aren't
    // in the DocumentMap alone, but set the cell to the DocImpl for the ones
    // that are present.
    // This does not preserve any dependency order like the topological sort
    // does, but I don't think we need to do this anymore.
    // I use the storage provider to get the nursery version if it's more recent.
    // This makes it so if I have local changes, they aren't lost.
    for (const entityId of entityIds) {
      const storageValue = storageProvider.get<JSONValue>(entityId);
      const newDoc = docMap.getDocByEntityId(doc.space, entityId, false)!;
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
          const newValue = Storage._cellLinkFromJSON(
            newDoc,
            storageValue,
            this.runtime,
          );
          newDoc.send(newValue.value);
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
        // Add to the set of writes
        valuesToSend.push({ entityId: entityId, value: docValue });
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
    return entityIds;
  }

  // Walk through the object, replacing any links to cells that were expressed
  // with a JSON string with the actual object from the DocumentMap.
  private static _cellLinkFromJSON<T>(
    doc: DocImpl<T>,
    storageValue: StorageValue<JSONValue>,
    runtime: IRuntime,
  ): StorageValue<any> {
    // Helper function that converts a JSONValue into an object where the
    // cell links have been replaced with DocImpl objects.
    const traverse = (value: JSONValue): any => {
      if (typeof value !== "object" || value === null) {
        return value;
      } else if (isLink(value)) {
        const link = parseLink(value, doc.asCell());
        const cell = runtime.getCellFromLink(link);

        // We don't convert here as we plan to remove this whole transformation
        // soon. So return value instead of creating a sigil link.
        return value;
      } else if ("cell" in value && "path" in value) {
        // If we see a doc link with just an id, then we replace it with
        // the actual doc:
        if (
          isRecord(value.cell) &&
          "/" in value.cell &&
          Array.isArray(value.path)
        ) {
          // Any dependent docs that we expected should already be loaded,
          // so we can just grab them from the runtime's document map.
          // If they aren't available, then leave the link in its raw form.
          const dependency = runtime.documentMap.getDocByEntityId(
            doc.space,
            value.cell as { "/": string },
            false,
          );
          if (dependency === undefined) {
            console.warn(
              "No match found for",
              value.cell,
              "; leaving cell unchanged",
            );
            return value;
          }
          // Previously, we would also call _ensureIsSyncedById to recursively
          // load the docs linked to by this dependency, but now we expect to
          // already have all the docs we need in our Provider. We still need
          // to do the subscription to changes through the Provider, and we
          // still need to connect the dependent docs to the Provider's data.
          // return value;
          return { ...value, cell: dependency };
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
    const newValue: StorageValue = {
      value: traverse(storageValue.value),
      source: storageValue.source,
    };

    return newValue;
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
          value = getCellLinkOrThrow(value);
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
      value: traverse(doc.get() as Readonly<any>),
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
    entityId: EntityId,
    storageProvider: IStorageProvider,
    schemaContext: SchemaContext = { schema: true, rootSchema: true },
  ) {
    const manager = new DocObjectManager(
      space,
      storageProvider,
      this.runtime.documentMap,
      Storage._cellLinkToJSON,
    );
    const idString = entityIdStr(entityId);
    const docAddress = manager.toAddress(idString);
    const selector = { path: [], schemaContext: schemaContext };
    return querySchema(selector, [], docAddress, manager);
  }

  private _subscribeToChanges(doc: DocImpl<any>): void {
    log(() => ["subscribe to changes", JSON.stringify(doc.entityId)]);

    const docId = entityIdStr(doc.entityId);

    // Clear any existing subscriptions first - we only want one callback
    // and if we call syncCell multiple times, we would end up
    // with multiple subscriptions.
    if (this.docToStorageSubs.has(docId)) {
      // Cancel any existing subscription
      this.docToStorageSubs.get(docId)?.();
      this.docToStorageSubs.delete(docId);
    }
    if (this.storageToDocSubs.has(docId)) {
      // Cancel any existing subscription
      this.storageToDocSubs.get(docId)?.();
      this.storageToDocSubs.delete(docId);
    }

    // Subscribe to doc changes, send updates to storage
    const docToStorage = doc.updates((value, _path, labels) => {
      log(
        () => [
          "got from doc",
          JSON.stringify(doc.entityId),
          JSON.stringify(value),
        ],
      );
      const storageValue = Storage._cellLinkToJSON(doc, labels);
      const existingValue = this._getStorageProviderForSpace(doc.space).get<
        JSONValue
      >(
        doc.entityId,
      );
      if (deepEqual(storageValue, existingValue)) {
        return;
      }
      // Track these promises for our synced call.
      const docToStoragePromise = this._getStorageProviderForSpace(doc.space)
        .send([{
          entityId: doc.entityId,
          value: storageValue,
        }]);
      this.docToStoragePromises.add(docToStoragePromise);
      docToStoragePromise.finally(() =>
        this.docToStoragePromises.delete(docToStoragePromise)
      );
    });
    this.addCancel(docToStorage);
    this.docToStorageSubs.set(docId, docToStorage);

    // This will be called when we get an update from the server,
    // and merge the changes into the heap.
    const storageToDoc = this._getStorageProviderForSpace(doc.space).sink<
      JSONValue
    >(
      doc.entityId!,
      (storageValue) => {
        const newValue = Storage._cellLinkFromJSON(
          doc,
          storageValue,
          this.runtime,
        );
        if (!deepEqual(newValue.value, doc.get())) {
          // values differ
          doc.send(newValue.value);
        }
        const newSourceCell = (newValue.source !== undefined)
          ? this.runtime.documentMap.getDocByEntityId(
            doc.space,
            newValue.source,
            false,
          )
          : undefined;
        if (doc.sourceCell !== newSourceCell) {
          doc.sourceCell = newSourceCell;
        }
      },
    );
    this.addCancel(storageToDoc);
    this.storageToDocSubs.set(docId, storageToDoc);
  }
}
