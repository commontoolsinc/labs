import type {
  JSONObject,
  JSONValue,
  SchemaContext,
} from "@commontools/builder";
import {
  BaseObjectManager,
  type CellTarget,
  CycleTracker,
  getAtPath,
  MapSet,
  SchemaObjectTraverser,
  type ValueAtPath,
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

  // get the fact address for the doc pointed to by the cell target
  override getTarget(target: CellTarget): FactAddress {
    return {
      the: "application/json",
      of: `of:${target.cellTarget}`,
    } as FactAddress;
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
  schemaContext: SchemaContext,
  path: string[],
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

  // We've provided a schema context for this, so traverse it
  const traverser = new SchemaObjectTraverser(
    manager,
    schemaContext,
    tracker,
    schemaTracker,
  );
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
  // We store the actual doc in the value field of the object
  const factValue = (valueEntry.value as JSONObject).value;
  const newDoc = getAtPath<
    FactAddress,
    FactAddress
  >(
    manager,
    { doc: factAddress, docRoot: factValue, path: [], value: factValue },
    path,
    tracker,
    schemaTracker,
    { path: [], schemaContext: schemaContext },
  );
  if (newDoc.value === undefined) {
    return {
      missing: [...manager.getMissingDocs()],
      loaded: rv,
      selected: schemaTracker,
    };
  }
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
