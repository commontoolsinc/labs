import { isRecord } from "@commontools/utils/types";
import { defer } from "@commontools/utils/defer";
import { Signer } from "@commontools/identity";
import type {
  FactAddress,
  JSONValue,
  MemorySpace,
  SchemaContext,
} from "@commontools/memory/interface";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import { Cell, type CellLink, isCell, isCellLink, isStream } from "./cell.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type EntityId } from "./doc-map.ts";
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
import type { IDocumentMap, IRuntime, IStorage } from "./runtime.ts";
import { DocObjectManager, querySchema } from "./storage/query.ts";
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

  private currentBatchPromise: Promise<void> = Promise.resolve();

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

    const entityDoc = this._syncCellHelper(cell, schemaContext);
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

  private _getStorageProviderForSpace(space: MemorySpace): IStorageProvider {
    if (!space) throw new Error("No space set");

    let provider = this.storageProviders.get(space);

    if (!provider) {
      provider = this.storageManager.open(space);
      this.storageProviders.set(space, provider);
    }
    return provider;
  }

  // Replacement for _ensureIsSynced
  private _syncCellHelper<T>(
    doc: DocImpl<T> | Cell<any>,
    schemaContext?: SchemaContext,
  ) {
    if (isCell(doc) || isStream(doc)) doc = doc.getDoc();
    if (!isDoc(doc)) {
      throw new Error("Invalid subject: " + JSON.stringify(doc));
    }
    if (!doc.entityId) throw new Error("Doc has no entity ID");

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
    const storageProvider = this._getStorageProviderForSpace(doc.space);
    const loadingPromise = storageProvider.sync(
      doc.entityId!,
      false,
      schemaContext,
    ).then((result) => {
      if (result.error) {
        // This will be a decoupled doc that is not persisted and cannot be edited
        doc.ephemeral = true;
        doc.freeze("loading error");
        return doc;
      } else {
        // I'm using the list of returned documents in the server's response,
        // allowing me to avoid running a local schema query.
        // TODO: This doesn't match the return signature of sync
        return this._integrateResult(
          doc,
          storageProvider,
          schemaContext,
          result.ok as [FactAddress, unknown][],
        ).then((_entityIds) => {
          this._resolvePromises(doc);
          return doc;
        });
      }
    });
    this.loadingPromises.set(doc, loadingPromise);

    // Create a promise that gets resolved once the doc and all its
    // dependencies are loaded. It'll return the doc when done.
    const { promise, resolve } = defer<void, Error>();
    this.loadingResolves.set(doc, resolve);
    this.docIsLoading.set(
      doc,
      promise.then(() => {
        console.log(
          "Resolved docIsloading for",
          JSON.stringify(doc.entityId),
          JSON.stringify(doc.value),
        );
        return doc;
      }),
    );

    // TODO: Previous version called addToBatch with sync here

    // Return the doc, to make calls chainable.
    return doc;
  }

  private _integrateResult<T>(
    doc: DocImpl<T>,
    storageProvider: IStorageProvider,
    schemaContext?: SchemaContext,
    selection?: [FactAddress, unknown][],
  ): Promise<EntityId[]> {
    console.log("selection", selection);
    const { missing, loaded, selected } = this._queryLocal(
      doc.space,
      doc.entityId,
      storageProvider,
      schemaContext,
    );
    console.log("missing", missing);
    // When using volatile from testing, we have an empty selection.
    // I don't try to handle this correctly, since
    // let selectionArray: [FactAddress, unknown][];
    // if (isRecord(selection) && selection.size === undefined) {
    //   console.log(
    //     "Working with volatile storage, so we don't have the response. Could use schema traversal.",
    //   );
    //   const idStr = doc.entityId.toJSON!()["/"];
    //   selectionArray = [[
    //     {
    //       of: `of:${idStr}`,
    //       the: "application/json",
    //     } as FactAddress,
    //     undefined,
    //   ]];
    // } else {
    //   console.log("_integrateResult selection", selection);
    //   selectionArray = [...selection];
    // }
    // Ignore any entries that aren't the json. We typically have the
    // per-space transaction entry, and may have labels.
    // We'll also ensure we're only dealing with the entity ids that will
    // be managed in our document map.
    //const entityIds = selectionArray.map(([docAddr, _value]) => docAddr)
    const entityIds = loaded.values().map((valueEntry) => valueEntry.source)
      .filter((docAddr) =>
        docAddr.the === "application/json" && docAddr.of.startsWith("of:")
      ).map((docAddr) => {
        return { "/": docAddr.of.slice(3) };
      }).toArray();
    console.log("Entity ids:", entityIds);
    return this._integrateResults(doc, storageProvider, entityIds);
  }

  // Take the data from our storage provider and integrate that into the
  // document map.
  private _integrateResults<T>(
    doc: DocImpl<T>,
    storageProvider: IStorageProvider,
    entityIds: EntityId[],
  ): Promise<EntityId[]> {
    const docMap = this.runtime.documentMap;
    // First, make sure we have all these docs in the runtime document map
    // This should also handle the source docs, since they will be included
    // in our query result.
    for (const entityId of entityIds) {
      console.log("Creating entry with entityId", entityId);
      docMap.getDocByEntityId(doc.space, entityId, true)!;
    }
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
      if (storageValue !== undefined) {
        // The object exists on the server
        console.log("value", storageValue);
        const newValue = Storage._cellLinkFromJSON(
          newDoc,
          storageValue,
          this.runtime.documentMap,
        );
        console.log("newvalue", newValue);
        newDoc.send(newValue.value);
        if (storageValue.source) {
          newDoc.sourceCell = this.runtime.documentMap.getDocByEntityId(
            doc.space,
            storageValue.source,
            false,
          );
        }
      } else if (newDoc !== undefined) {
        // The object doesn't exist on the server. -- TODO: is this true?
        // TODO: labels
        const newValue = Storage._cellLinkToJSON(newDoc);
        valuesToSend.push({ entityId: entityId, value: newValue });
        // Generate a set of writes
      }

      // Any updates to these docs should be sent to storage, and any update
      // in storage should be used to update these docs.
      this._subscribeToChanges(newDoc);
    }
    if (valuesToSend.length > 0) {
      // Don't worry about redundant sends, since the provider handles that.
      return storageProvider.send(valuesToSend).then((result) => {
        if (result.error) {
          console.log("Failed to write objects");
          return [];
        } else {
          return entityIds;
        }
      });
    }
    return Promise.resolve(entityIds);
  }

  // Previously, this was handled by _processCurrentBatch, but now we're handling this
  // directly from our sync promise resolution.
  private _resolvePromises<T>(doc: DocImpl<T>) {
    // We aren't using _processCurrentBatch for these,
    this.loadingPromises.delete(doc);
    this.docIsLoading.delete(doc);
    this.loadingResolves.get(doc)?.();
  }

  // Walk through the object, replacing any links to cells that were expressed
  // with a JSON string with the actual object from the DocumentMap.
  static _cellLinkFromJSON<T>(
    doc: DocImpl<T>,
    storageValue: StorageValue<JSONValue>,
    documentMap: IDocumentMap,
  ): StorageValue<any> {
    // Helper function that converts a JSONValue into an object where the
    // cell links have been replaced with DocImpl objects.
    const traverse = (value: JSONValue): any => {
      if (typeof value !== "object" || value === null) {
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
          const dependency = documentMap.getDocByEntityId(
            doc.space,
            value.cell as { "/": string },
            false,
          );
          if (dependency === undefined) {
            console.log(
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
  static _cellLinkToJSON<T>(
    doc: DocImpl<T>,
    labels?: Labels,
  ): StorageValue<JSONValue> {
    // Traverse the value and for each doc reference, make sure it's persisted.
    // This is done recursively.
    const traverse = (
      value: Readonly<any>,
      path: PropertyKey[],
    ): JSONValue => {
      // If it's a doc, make it a doc link -- we'll swap this for json below
      if (isDoc(value)) value = { cell: value, path: [] } satisfies CellLink;

      // If it's a query result proxy, make it a doc link
      if (isQueryResultForDereferencing(value)) {
        value = getCellLinkOrThrow(value);
      }

      // If it's a doc link, convert it to a doc link with an id
      if (isCellLink(value)) {
        return {
          ...value,
          path: value.path.map((pk) => pk.toString()),
          cell: value.cell.toJSON!()!, /* = the id */
        };
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

    // Convert all doc references to ids and remember as dependent docs
    const newValue: StorageValue<JSONValue> = {
      value: traverse(doc.get() as Readonly<any>, []),
      source: doc.sourceCell?.entityId,
      ...(labels !== undefined) ? { labels: labels } : {},
    };

    return newValue;
  }

  // Run a query locally against either the docmap or the storageprovider
  private _queryLocal<T>(
    space: MemorySpace,
    entityId: EntityId,
    storageProvider: IStorageProvider,
    schemaContext?: SchemaContext,
  ) {
    const manager = new DocObjectManager(
      space,
      storageProvider,
      this.runtime.documentMap,
      Storage._cellLinkToJSON,
    );
    const entityIdStr = entityId.toJSON
      ? entityId.toJSON!()["/"]
      : entityId["/"] as string;
    const docAddress = manager.toAddress(entityIdStr);
    console.log("Calling query local on", docAddress);
    const selector = {
      schemaContext: schemaContext ?? { schema: true, rootSchema: true },
      path: [],
    };
    return querySchema(selector, [], docAddress, manager);
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
        const storageValue = Storage._cellLinkToJSON(doc, labels);
        return this._getStorageProviderForSpace(doc.space).send([{
          entityId: doc.entityId,
          value: storageValue,
        }]);
      }),
    );

    // Subscribe to storage updates, send results to doc
    this.addCancel(
      this._getStorageProviderForSpace(doc.space).sink(
        doc.entityId!,
        (storageValue) => {
          const newValue = Storage._cellLinkFromJSON(
            doc,
            storageValue,
            this.runtime.documentMap,
          );
          doc.send(newValue.value);
        },
      ),
    );
  }
}
