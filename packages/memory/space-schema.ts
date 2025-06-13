import type { JSONObject, JSONValue } from "@commontools/builder";
import {
  BaseObjectManager,
  type CellTarget,
  CycleTracker,
  DefaultSchemaSelector,
  getAtPath,
  MapSet,
  type PointerCycleTracker,
  SchemaObjectTraverser,
  type ValueEntry,
} from "@commontools/builder/traverse";
import { type Immutable, isObject } from "@commontools/utils/types";
import { the as COMMIT_THE } from "./commit.ts";
import type { CommitData, SchemaPathSelector } from "./consumer.ts";
import { TheAuthorizationError } from "./error.ts";
import {
  type Cause,
  type Entity,
  type FactAddress,
  type FactSelection,
  type MemorySpace,
  type SchemaQuery,
} from "./interface.ts";
import { SelectAllString } from "./schema.ts";
import {
  getChange,
  getRevision,
  iterate,
  iterateSelector,
  setEmptyObj,
  setRevision,
} from "./selection.ts";
import {
  collectClassifications,
  type FactSelectionValue,
  FactSelector,
  getClassifications,
  getLabel,
  getLabels,
  redactCommitData,
  type SelectedFact,
  selectFact,
  selectFacts,
  type Session,
  toSelection,
} from "./space.ts";

export type * from "./interface.ts";

type FullFactAddress = FactAddress & { cause: Cause; since: number };

// This class is used to manage the underlying objects in storage, so the
// class that traverses the docs doesn't need to know the implementation.
// It also lets us use one system on the server (where we have the sqlite db)
// and another system on the client.
export class ServerObjectManager extends BaseObjectManager<
  FactAddress,
  FullFactAddress,
  Immutable<JSONValue> | undefined
> {
  // Cache our read labels, and any docs we can't read
  private readLabels = new Map<Entity, SelectedFact | undefined>();
  private restrictedValues = new Set<string>();

  constructor(
    private session: Session<MemorySpace>,
    private providedClassifications: Set<string>,
  ) {
    super();
  }

  override toKey(doc: FactAddress): string {
    return `${doc.of}/${doc.the}`;
  }

  override getTarget(target: CellTarget): FactAddress {
    return {
      the: "application/json",
      of: `of:${target.cellTarget}`,
    } as FactAddress;
  }

  /**
   * Load the facts for the provided doc
   *
   * @param doc the address of the fact to load
   * @returns a ValueEntry with the value for the specified doc,
   * null if there is no matching fact, or undefined if there is a retraction.
   */
  override load(
    doc: FactAddress,
  ): ValueEntry<FullFactAddress, JSONValue | undefined> | null {
    const key = this.toKey(doc);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    } else if (this.restrictedValues.has(key)) {
      return null;
    }
    const fact = selectFact(this.session, doc);
    if (fact !== undefined) {
      const valueEntry = {
        source: {
          of: fact.of,
          the: fact.the,
          cause: fact.cause,
          since: fact.since,
        },
        value: fact.is ? (fact.is as JSONObject) : undefined,
      };
      if (!this.readLabels.has(doc.of)) {
        const label = getLabel(this.session, doc.of);
        this.readLabels.set(doc.of, label);
      }
      const labelEntry = this.readLabels.get(doc.of);
      if (labelEntry?.is) {
        const requiredClassifications = getClassifications({
          is: labelEntry.is,
          since: labelEntry.since,
        });
        if (!requiredClassifications.isSubsetOf(this.providedClassifications)) {
          console.log(
            `Skipping inclusion of ${fact.of}, due to classification`,
          );
          this.restrictedValues.add(key);
          return null;
        }
      }
      this.readValues.set(key, valueEntry);
      return valueEntry;
    }
    return null;
  }

  getReadDocs(): Iterable<ValueEntry<FullFactAddress, JSONValue | undefined>> {
    return this.readValues.values();
  }

  getLabels(): Iterable<[Entity, SelectedFact | undefined]> {
    return this.readLabels.entries();
  }
}

export const selectSchema = <Space extends MemorySpace>(
  session: Session<Space>,
  { selectSchema, since, classification }: SchemaQuery["args"],
  selectionTracker?: MapSet<string, SchemaPathSelector>,
): FactSelection => {
  const providedClassifications = new Set<string>(classification);
  // Track any docs loaded while traversing the factSelection
  const manager = new ServerObjectManager(session, providedClassifications);
  // while loading dependent docs, we want to avoid cycles
  const tracker = new CycleTracker<Immutable<JSONValue>>();
  const schemaTracker = new MapSet<string, SchemaPathSelector>();

  const includedFacts: FactSelection = {}; // we'll store all the raw facts we accesed here
  // First, collect all the potentially relevant facts (without dereferencing pointers)
  for (
    const selectorEntry of iterateSelector(selectSchema, DefaultSchemaSelector)
  ) {
    const factSelector = {
      of: selectorEntry.of,
      the: selectorEntry.the,
      cause: selectorEntry.cause,
      since,
    };
    const matchingFacts = getMatchingFacts(session, factSelector);
    for (const entry of matchingFacts) {
      const factKey = manager.toKey({
        of: entry.source.of,
        the: entry.source.the,
      });
      // TODO(@ubik2): need to remove this or schemaTracker
      selectionTracker?.add(factKey, selectorEntry.value);
      // The top level facts we accessed should be included
      addToSelection(includedFacts, entry);

      // Then filter the facts by the associated schemas, which will dereference
      // pointers as we walk through the structure.
      loadFactsForDoc(
        manager,
        entry,
        selectorEntry.value,
        tracker,
        schemaTracker,
      );

      // Add any facts that we accessed while traversing the object with its schema
      // We'll need the same set of objects on the client to traverse it there.
      for (const entry of manager.getReadDocs()) {
        addToSelection(includedFacts, entry);
      }
    }
  }

  // We want to collect the classification tags on our included facts
  const labelFacts = getLabels(session, includedFacts);
  const requiredClassifications = collectClassifications(labelFacts);
  if (!requiredClassifications.isSubsetOf(providedClassifications)) {
    throw new TheAuthorizationError("Insufficient access");
  }

  // We want to include all the labels for the selected entities as well,
  // since the client may want to change the label, and they'll want the
  // original with a cause for that to be valid.
  // We sort them first, so the client will just see the latest included label
  const sortedLabelFacts = [...iterate(labelFacts)].sort((a, b) =>
    a.value.since - b.value.since
  );
  for (const entry of sortedLabelFacts) {
    setRevision(includedFacts, entry.of, entry.the, entry.cause, entry.value);
  }

  // We may have included the application/commit+json of the space in the query
  // If so, we should redact that based on available classifications.
  // Our result will contain at most one revision of that doc.
  redactCommits(includedFacts, session);

  // Any entities referenced in our selectSchema must be returned in the response
  // I'm not sure this is the best behavior, but it matches the schema-free query code.
  // Our returned stub objects will not have a cause.
  // TODO(@ubik2) See if I can remove this
  for (
    const factSelector of iterateSelector(selectSchema, DefaultSchemaSelector)
  ) {
    if (
      factSelector.of !== SelectAllString &&
      factSelector.the !== SelectAllString &&
      !getRevision(includedFacts, factSelector.of, factSelector.the)
    ) {
      setEmptyObj(includedFacts, factSelector.of, factSelector.the);
    }
  }
  return includedFacts;
};

function loadFactsForDoc(
  manager: ServerObjectManager,
  fact: ValueEntry<FullFactAddress, Immutable<JSONValue> | undefined>,
  selector: SchemaPathSelector,
  tracker: PointerCycleTracker,
  schemaTracker: MapSet<string, SchemaPathSelector>,
) {
  if (isObject(fact.value)) {
    const factAddress = { of: fact.source.of, the: fact.source.the };
    if (selector.schemaContext !== undefined) {
      const factValue = (fact.value as Immutable<JSONObject>).value;
      const [newDoc, newSelector] = getAtPath<
        FactAddress,
        FullFactAddress
      >(
        manager,
        { doc: factAddress, docRoot: factValue, path: [], value: factValue },
        selector.path,
        tracker,
        schemaTracker,
        selector,
      );
      if (newDoc.value === undefined) {
        return;
      }
      // We've provided a schema context for this, so traverse it
      const traverser = new SchemaObjectTraverser(
        manager,
        newSelector!,
        tracker,
        schemaTracker,
      );
      // We don't actually use the return value here, but we've built up
      // a list of all the documents we need to watch.
      traverser.traverse(newDoc);
    } else {
      // If we didn't provide a schema context, we still want the selected
      // object in our manager, so load it directly.
      manager.load(factAddress);
    }
  }
}

const redactCommits = <Space extends MemorySpace>(
  includedFacts: FactSelection,
  session: Session<Space>,
) => {
  const change = getChange(includedFacts, session.subject, COMMIT_THE);
  if (change !== undefined) {
    const [cause, value] = change;
    const commitData = value.is as CommitData;
    // attach labels to the commit, so the provider can remove any classified entries from the commit before we send it to subscribers
    // For this, we need since fields on our objects to determine labels
    const changedFacts = toSelection(
      commitData.since,
      commitData.transaction.args.changes,
    );
    const labels = getLabels(session, changedFacts);
    if (Object.keys(labels).length > 0) {
      commitData.labels = labels;
    }
    // we don't need the since field anymore for these facts
    const redactedData = redactCommitData(commitData);
    const redactedValue = (redactedData !== undefined)
      ? { is: redactedData, since: commitData.since }
      : { since: commitData.since };
    setRevision<FactSelectionValue>(
      includedFacts,
      session.subject,
      COMMIT_THE,
      cause,
      redactedValue,
    );
  }
};

// Adds the ValueEntry's object to the selection, merging the since
// into the `is` field.
function addToSelection(
  includedFacts: FactSelection,
  entry: ValueEntry<FullFactAddress, JSONValue | undefined>,
) {
  setRevision(
    includedFacts,
    entry.source.of,
    entry.source.the,
    entry.source.cause,
    (entry.value !== undefined)
      ? { is: entry.value, since: entry.source.since }
      : { since: entry.source.since },
  );
}

// Get the ValueEntry objects for the facts that match our selector
function getMatchingFacts<Space extends MemorySpace>(
  session: Session<Space>,
  factSelector: FactSelector,
): Iterable<ValueEntry<FullFactAddress, JSONValue | undefined>> {
  const results = [];
  for (const fact of selectFacts(session, factSelector)) {
    results.push({
      value: fact.is,
      source: {
        of: fact.of,
        the: fact.the,
        cause: fact.cause,
        since: fact.since,
      },
    });
  }
  return results;
}
