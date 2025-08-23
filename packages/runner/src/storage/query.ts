import type {
  MemorySpace,
  Revision,
  SchemaPathSelector,
  State,
  URI,
} from "@commontools/memory/interface";
import type { JSONObject, JSONValue } from "../builder/types.ts";
import type { DocImpl } from "../doc.ts";
import { entityIdStr } from "../doc-map.ts";
import type { IMemoryAddress, StorageValue } from "./interface.ts";
import type { IDocumentMap, IStorageProvider } from "../runtime.ts";
import {
  type BaseMemoryAddress,
  BaseObjectManager,
  CycleTracker,
  getAtPath,
  IAttestation,
  loadSource,
  MapSet,
  MinimalSchemaSelector,
  SchemaObjectTraverser,
} from "../traverse.ts";
import { uriToEntityId } from "./transaction-utils.ts";

export abstract class ClientObjectManager
  extends BaseObjectManager<BaseMemoryAddress, JSONValue | undefined> {
  // Cache our read labels, and any docs we can't read
  public missingDocs = new Map<string, BaseMemoryAddress>();

  constructor() {
    super();
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<BaseMemoryAddress> {
    return this.missingDocs.values();
  }
}

// Object Manager backed by a store map
export class StoreObjectManager extends ClientObjectManager {
  constructor(
    private store: Map<string, Revision<State>>,
  ) {
    super();
  }

  // Returns null if there is no matching fact
  override load(address: BaseMemoryAddress): IAttestation | null {
    const key = this.toKey(address);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    }
    // we should only have one match
    if (this.store.has(key)) {
      const storeValue = this.store.get(key);
      const rv = { address: { path: [], ...address }, value: storeValue?.is };
      this.readValues.set(key, rv);
      return rv;
    } else {
      if (!this.missingDocs.has(key)) {
        this.missingDocs.set(key, address);
      }
    }
    return null;
  }
}

// Object Manager backed by an IRuntime.
// This will first look in the DocMap, and if that fails, it will look in the storage provider.
export class DocObjectManager extends ClientObjectManager {
  constructor(
    private space: MemorySpace,
    private storageProvider: IStorageProvider,
    private documentMap: IDocumentMap,
    private cellLinkToJSON: (doc: DocImpl<any>) => StorageValue<JSONValue>,
  ) {
    super();
  }
  override load(address: BaseMemoryAddress): IAttestation | null {
    const key = this.toKey(address);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    }
    // strip off the leading "of:"
    const entityId = uriToEntityId(address.id);
    // First, check the document map
    const docMapEntry = this.documentMap.getDocByEntityId(
      this.space,
      entityId,
      false,
    );
    // I exclude entries where the value is undefined. While that could be
    // used to represent a retraction, it's much more likely to mean that
    // the object is being created, and we should use the value from storage.
    if (docMapEntry !== undefined && docMapEntry.value !== undefined) {
      // Use the storage class to convert this doc to json
      const storageValue = this.cellLinkToJSON(
        docMapEntry,
      );
      const valEntryValue: { value: JSONValue; source?: { "/": string } } = {
        value: storageValue.value,
      };
      if (storageValue.source !== undefined) {
        valEntryValue.source = { "/": entityIdStr(storageValue.source) };
      }
      const rv: IAttestation = {
        address: { path: [], ...address },
        value: valEntryValue,
      };
      this.readValues.set(key, rv);
      return rv;
    }
    // Next, check the storage provider
    const storageEntry = this.storageProvider.get<JSONValue>(address.id);
    if (storageEntry !== undefined) {
      const valEntryValue: { value: JSONValue; source?: { "/": string } } = {
        value: storageEntry.value,
      };
      if (storageEntry.source !== undefined) {
        valEntryValue.source = { "/": entityIdStr(storageEntry.source) };
      }
      const rv: IAttestation = {
        address: { path: [], ...address },
        value: valEntryValue,
      };
      this.readValues.set(key, rv);
      return rv;
    }
    // Looks like it's missing
    if (!this.missingDocs.has(key)) {
      this.missingDocs.set(key, address);
    }
    return null;
  }
}

export function querySchema(
  selector: SchemaPathSelector,
  address: IMemoryAddress,
  manager: ClientObjectManager,
): {
  missing: BaseMemoryAddress[];
  loaded: Set<IAttestation>;
  selected: MapSet<string, SchemaPathSelector>;
} {
  // Then filter the facts by the associated schemas, which will dereference
  // pointers as we walk through the structure.

  const tracker = new CycleTracker<JSONValue>();
  const schemaTracker = new MapSet<string, SchemaPathSelector>();

  const rv = new Set<IAttestation>();
  const valueEntry = manager.load(address);
  if (valueEntry === null) {
    // If we don't have the top document, we don't have all the documents
    return { missing: [address], loaded: rv, selected: schemaTracker };
  } else if (valueEntry.value === undefined) {
    // we have a retracted fact
    rv.add(valueEntry);
    return { missing: [], loaded: rv, selected: schemaTracker };
  }
  schemaTracker.add(manager.toKey(address), selector);
  // Also load any source links
  loadSource(
    manager,
    valueEntry,
    new Set<string>(),
    schemaTracker,
  );
  // We store the actual doc in the value field of the object
  const factValue = (valueEntry.value as JSONObject).value;
  const [newDoc, _] = getAtPath(
    manager,
    {
      address: { ...address, path: [] },
      value: factValue,
      rootValue: factValue,
    },
    address.path,
    tracker,
    schemaTracker,
    MinimalSchemaSelector,
  );
  if (newDoc === undefined) {
    console.log("Encountered missing doc", newDoc, "; valueEntry", valueEntry);
    return {
      missing: [...manager.getMissingDocs()],
      loaded: rv,
      selected: schemaTracker,
    };
  }
  selector = { ...selector, path: newDoc.address.path };
  // We've provided a schema context for this, so traverse it
  const traverser = new SchemaObjectTraverser(
    manager,
    selector,
    tracker,
    schemaTracker,
  );

  // We don't actually use the return value here, but we've built up
  // a list of all the documents we read.
  traverser.traverse(newDoc);
  for (const item of manager.getReadDocs()) {
    rv.add(item);
  }
  return {
    missing: [...manager.getMissingDocs()],
    loaded: rv,
    selected: schemaTracker,
  };
}
