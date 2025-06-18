import type { JSONObject, JSONValue } from "../builder/types.ts";
import { IDocumentMap, IRuntime, IStorageProvider } from "../runtime.ts";
import {
  BaseObjectManager,
  type CellTarget,
  CycleTracker,
  getAtPath,
  loadSource,
  MapSet,
  MinimalSchemaSelector,
  SchemaObjectTraverser,
  type ValueEntry,
} from "../traverse.ts";
import { Storage } from "../storage.ts";
import type {
  FactAddress,
  MemorySpace,
  Revision,
  SchemaPathSelector,
  State,
} from "@commontools/memory/interface";
import { DocImpl } from "../doc.ts";
import { StorageValue } from "./interface.ts";

export abstract class ClientObjectManager extends BaseObjectManager<
  FactAddress,
  FactAddress,
  JSONValue | undefined
> {
  // Cache our read labels, and any docs we can't read
  public missingDocs = new Map<string, FactAddress>();

  constructor() {
    super();
  }

  override toKey(doc: FactAddress): string {
    return `${doc.of}/${doc.the}`;
  }

  override toAddress(str: string): FactAddress {
    return { of: `of:${str}`, the: "application/json" };
  }

  // get the fact address for the doc pointed to by the cell target
  override getTarget(target: CellTarget): FactAddress {
    return this.toAddress(target.cellTarget!);
  }

  getReadDocs(): Iterable<ValueEntry<FactAddress, JSONValue | undefined>> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<FactAddress> {
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
  override load(
    doc: FactAddress,
  ): ValueEntry<FactAddress, JSONValue | undefined> | null {
    const key = this.toKey(doc);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    }
    const factSelector: FactAddress = {
      of: doc.of,
      the: doc.the,
    };
    // we should only have one match
    if (this.store.has(key)) {
      const storeValue = this.store.get(key);
      const rv = { source: doc, value: storeValue?.is };
      this.readValues.set(key, rv);
      return rv;
    } else {
      if (!this.missingDocs.has(key)) {
        this.missingDocs.set(key, doc);
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
  override load(
    doc: FactAddress,
  ): ValueEntry<FactAddress, JSONValue | undefined> | null {
    const key = this.toKey(doc);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    }
    const factSelector: FactAddress = {
      of: doc.of,
      the: doc.the,
    };
    // strip off the leading "of:"
    const entityId = { "/": doc.of.slice(3) };
    // First, check the document map
    const docMapEntry = this.documentMap.getDocByEntityId(
      this.space,
      entityId,
      false,
    );
    if (docMapEntry !== undefined) {
      // Use the storage class to convert this doc to json
      const storageValue = this.cellLinkToJSON(
        docMapEntry,
      );
      console.log("storageValue from docMap", storageValue);
      const docMapValue: { value: JSONValue; source?: string } = {
        value: storageValue.value,
      };
      if (storageValue.source !== undefined) {
        docMapValue.source = storageValue.source.toJSON!()["/"];
      }
      const rv: ValueEntry<FactAddress, JSONValue> = {
        source: doc,
        value: docMapValue,
      };
      this.readValues.set(key, rv);
      return rv;
    }
    // Next, check the storage provider
    const storageEntry = this.storageProvider.get<JSONValue>(entityId);
    if (storageEntry !== undefined) {
      const rv = { source: doc, value: storageEntry.value };
      this.readValues.set(key, rv);
      return rv;
    }
    // Looks like it's missing
    if (!this.missingDocs.has(key)) {
      this.missingDocs.set(key, doc);
    }
    return null;
  }
}

export function querySchema(
  selector: SchemaPathSelector,
  path: readonly string[],
  factAddress: FactAddress,
  manager: ClientObjectManager,
): {
  missing: FactAddress[];
  loaded: Set<ValueEntry<FactAddress, JSONValue | undefined>>;
  selected: MapSet<string, SchemaPathSelector>;
} {
  // Then filter the facts by the associated schemas, which will dereference
  // pointers as we walk through the structure.

  const tracker = new CycleTracker<JSONValue>();
  const schemaTracker = new MapSet<string, SchemaPathSelector>();

  const rv = new Set<ValueEntry<FactAddress, JSONValue | undefined>>();
  const valueEntry = manager.load(factAddress);
  if (valueEntry === null) {
    // If we don't have the top document, we don't have all the documents
    return { missing: [factAddress], loaded: rv, selected: schemaTracker };
  } else if (valueEntry.value === undefined) {
    // we have a retracted fact
    rv.add(valueEntry);
    return { missing: [], loaded: rv, selected: schemaTracker };
  }
  console.log(
    "Got past the basic checks in query",
    [...manager.getReadDocs()].map((item) => item.source),
  );
  schemaTracker.add(manager.toKey(factAddress), selector);
  // Also load any source links
  loadSource(
    manager,
    factAddress,
    valueEntry,
    new Set<string>(),
    schemaTracker,
  );
  // We store the actual doc in the value field of the object
  const factValue = (valueEntry.value as JSONObject).value;
  const [newDoc, _] = getAtPath<
    FactAddress,
    FactAddress
  >(
    manager,
    { doc: factAddress, docRoot: factValue, path: [], value: factValue },
    path,
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
  selector = { ...selector, path: newDoc.path };
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
  console.log("read docs", [...manager.getReadDocs()]);
  for (const item of manager.getReadDocs()) {
    rv.add(item);
  }
  return {
    missing: [...manager.getMissingDocs()],
    loaded: rv,
    selected: schemaTracker,
  };
}
