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
  SchemaObjectTraverser,
  type ValueEntry,
} from "@commontools/builder/traverse";
import type {
  FactAddress,
  Revision,
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

  toKey(doc: FactAddress): string {
    return `${doc.of}/${doc.the}`;
  }

  // load the doc pointed to by the cell target
  getTarget(target: CellTarget): FactAddress {
    return {
      the: "application/json",
      of: `of:${target.cellTarget}`,
    } as FactAddress;
  }

  // Returns null if there is no matching fact
  load(
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

// TODO: Add since fields to the return
export function querySchemaHeap(
  schemaContext: SchemaContext,
  path: string[],
  factAddress: FactAddress,
  store: Map<string, Revision<State>>,
): {
  missing: FactAddress[];
  loaded: Set<ValueEntry<FactAddress, JSONValue | undefined>>;
} {
  const helper = new ClientObjectManager(store);
  // Then filter the facts by the associated schemas, which will dereference
  // pointers as we walk through the structure.

  const tracker = new CycleTracker<JSONValue>();
  // We've provided a schema context for this, so traverse it
  const traverser = new SchemaObjectTraverser(
    helper,
    schemaContext,
    schemaContext.rootSchema,
    tracker,
  );
  const rv = new Set<ValueEntry<FactAddress, JSONValue | undefined>>();
  const valueEntry = helper.load(factAddress);
  if (valueEntry === null) {
    // If we don't have the top document, we don't have all the documents
    return { missing: [factAddress], loaded: rv };
  } else if (valueEntry.value === undefined) {
    // we have a retracted fact
    rv.add(valueEntry);
    return { missing: [], loaded: rv };
  }
  // We store the actual doc in the value field of the object
  const factValue = (valueEntry.value as JSONObject).value;
  const [newDoc, newDocRoot, newValue] = getAtPath<FactAddress, FactAddress>(
    helper,
    factAddress,
    factValue,
    factValue,
    path,
    tracker,
  );
  if (newValue === undefined) {
    return { missing: [...helper.getMissingDocs()], loaded: rv };
  }
  // We don't actually use the return value here, but we've built up
  // a list of all the documents we read.
  traverser.traverse(newDoc, newDocRoot, newValue);
  for (const item of helper.getReadDocs()) {
    rv.add(item);
  }
  return { missing: [...helper.getMissingDocs()], loaded: rv };
}
