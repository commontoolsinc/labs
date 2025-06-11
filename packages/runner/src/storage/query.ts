import type { JSONObject, JSONValue } from "@commontools/builder";
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
} from "@commontools/builder/traverse";
import type {
  FactAddress,
  Revision,
  SchemaPathSelector,
  State,
} from "@commontools/memory/interface";

export class ClientObjectManager extends BaseObjectManager<
  FactAddress,
  FactAddress,
  JSONValue | undefined
> {
  // Cache our read labels, and any docs we can't read
  public missingDocs = new Map<string, FactAddress>();

  constructor(
    private store: Map<string, Revision<State>>,
  ) {
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
      return { source: doc, value: storeValue?.is };
    } else {
      if (!this.missingDocs.has(key)) {
        this.missingDocs.set(key, doc);
      }
    }
    return null;
  }

  getReadDocs(): Iterable<ValueEntry<FactAddress, JSONValue | undefined>> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<FactAddress> {
    return this.missingDocs.values();
  }
}

export function querySchemaHeap(
  selector: SchemaPathSelector,
  path: readonly string[],
  factAddress: FactAddress,
  store: Map<string, Revision<State>>,
): {
  missing: FactAddress[];
  loaded: Set<ValueEntry<FactAddress, JSONValue | undefined>>;
  selected: MapSet<string, SchemaPathSelector>;
} {
  const manager = new ClientObjectManager(store);
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
  if (newDoc.value === undefined) {
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
  for (const item of manager.getReadDocs()) {
    rv.add(item);
  }
  return {
    missing: [...manager.getMissingDocs()],
    loaded: rv,
    selected: schemaTracker,
  };
}
