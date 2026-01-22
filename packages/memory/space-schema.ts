import {
  ContextualFlowControl,
  deepEqual,
  type JSONObject,
  type JSONValue,
  type SchemaContext,
} from "@commontools/runner";
import {
  BaseMemoryAddress,
  BaseObjectManager,
  CompoundCycleTracker,
  DefaultSchemaSelector,
  getAtPath,
  type IAttestation,
  loadSource,
  MapSet,
  type PointerCycleTracker,
  SchemaObjectTraverser,
} from "@commontools/runner/traverse";
import { type Immutable, isObject } from "@commontools/utils/types";
import { getLogger } from "@commontools/utils/logger";
import { COMMIT_LOG_TYPE } from "./commit.ts";
import type { CommitData, SchemaPathSelector } from "./consumer.ts";
import { TheAuthorizationError } from "./error.ts";
import type {
  CauseString,
  Entity,
  FactSelection,
  MemorySpace,
  MIME,
  SchemaQuery,
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
  type Session as SpaceStoreSession,
  toSelection,
} from "./space.ts";

export type * from "./interface.ts";

const logger = getLogger("space-schema", {
  enabled: false,
  level: "info",
});

// This class is used to manage the underlying objects in storage, so the
// class that traverses the docs doesn't need to know the implementation.
// It also lets us use one system on the server (where we have the sqlite db)
// and another system on the client.
export class ServerObjectManager extends BaseObjectManager<
  BaseMemoryAddress,
  Immutable<JSONValue> | undefined
> {
  // Cache our read labels, and any docs we can't read
  private readLabels = new Map<Entity, SelectedFact | undefined>();
  // Mapping from factKey to object with cause and since
  private factDetails = new Map<
    string,
    { cause: CauseString; since: number }
  >();
  private restrictedValues = new Set<string>();

  constructor(
    private session: SpaceStoreSession<MemorySpace>,
    private providedClassifications: Set<string>,
  ) {
    super();
  }

  /**
   * Load the facts for the provided address
   *
   * @param address the address of the fact to load
   * @returns an IAttestation with the value for the specified doc,
   * null if there is no matching fact, or undefined if there is a retraction.
   */
  override load(address: BaseMemoryAddress): IAttestation | null {
    const key = this.toKey(address);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    } else if (this.restrictedValues.has(key)) {
      return null;
    }
    const fact = selectFact(this.session, {
      of: address.id,
      the: address.type,
    });
    if (fact !== undefined) {
      const address = { id: fact.of, type: fact.the, path: [] };
      const valueEntry = {
        address: address,
        value: fact.is ? (fact.is as JSONObject) : undefined,
      };
      if (!this.readLabels.has(address.id)) {
        const label = getLabel(this.session, address.id);
        this.readLabels.set(address.id, label);
      }
      const labelEntry = this.readLabels.get(address.id);
      if (labelEntry?.is) {
        const requiredClassifications = getClassifications({
          is: labelEntry.is,
          since: labelEntry.since,
        });
        if (!requiredClassifications.isSubsetOf(this.providedClassifications)) {
          logger.info(
            "classification-skip",
            () => ["Skipping inclusion of", fact.of, "due to classification"],
          );
          this.restrictedValues.add(key);
          return null;
        }
      }
      // Any entry in readValues should also have an entry in factDetails
      this.factDetails.set(this.toKey(address), {
        cause: fact.cause,
        since: fact.since,
      });
      this.readValues.set(key, valueEntry);
      return valueEntry;
    }
    return null;
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getLabels(): Iterable<[Entity, SelectedFact | undefined]> {
    return this.readLabels.entries();
  }

  getDetails(address: BaseMemoryAddress) {
    return this.factDetails.get(this.toKey(address));
  }
}

export interface SelectSchemaResult {
  facts: FactSelection;
  schemaTracker: MapSet<string, SchemaPathSelector>;
}

export const selectSchema = <Space extends MemorySpace>(
  session: SpaceStoreSession<Space>,
  { selectSchema, since, classification }: SchemaQuery["args"],
  existingSchemaTracker?: MapSet<string, SchemaPathSelector>,
): SelectSchemaResult => {
  const startTime = performance.timeOrigin + performance.now();

  const providedClassifications = new Set<string>(classification);
  // Track any docs loaded while traversing the factSelection
  const manager = new ServerObjectManager(session, providedClassifications);
  // while loading dependent docs, we want to avoid cycles
  const tracker = new CompoundCycleTracker<
    Immutable<JSONValue>,
    SchemaContext | undefined
  >();
  const cfc = new ContextualFlowControl();
  // Use existing tracker if provided, otherwise create new one
  const schemaTracker = existingSchemaTracker ??
    new MapSet<string, SchemaPathSelector>(deepEqual);

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
      // The top level facts we accessed should be included
      addToSelection(includedFacts, entry, entry.cause, entry.since);

      // Then filter the facts by the associated schemas, which will dereference
      // pointers as we walk through the structure.
      loadFactsForDoc(
        manager,
        entry,
        selectorEntry.value,
        tracker,
        cfc,
        schemaTracker,
      );

      // Add any facts that we accessed while traversing the object with its schema
      // We'll need the same set of objects on the client to traverse it there.
      for (const included of manager.getReadDocs()) {
        const details = manager.getDetails(included.address)!;
        addToSelection(includedFacts, included, details.cause, details.since);
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
      factSelector.the !== SelectAllString
    ) {
      // Track all specifically-queried entities in schemaTracker so incremental
      // updates can detect changes to them, even if they don't have data yet
      const docKey = `${factSelector.of}/${factSelector.the}`;
      if (!schemaTracker.has(docKey)) {
        schemaTracker.add(docKey, factSelector.value);
      }

      if (!getRevision(includedFacts, factSelector.of, factSelector.the)) {
        setEmptyObj(includedFacts, factSelector.of, factSelector.the);
      }
    }
  }
  const endTime = performance.timeOrigin + performance.now();
  if ((endTime - startTime) > 100) {
    logger.info("slow-select", () => ["Slow selectSchema:", selectSchema]);
  }

  return { facts: includedFacts, schemaTracker };
};

export interface EvaluateLinksResult {
  schemaTracker: MapSet<string, SchemaPathSelector>;
  /** Newly discovered doc+schema pairs that weren't already in the tracker */
  newLinks: Array<{ docKey: string; schema: SchemaPathSelector }>;
}

/**
 * Evaluates a single document with a schema and returns the links it contains.
 * Used for incremental subscription updates - when a document changes, we re-evaluate
 * just that document to find what links it now has.
 *
 * @param session - The space store session
 * @param docAddress - The document to evaluate (id and type)
 * @param schema - The schema to apply
 * @param classification - Classification claims for access control
 * @returns An object with the schemaTracker and newly discovered links, or null if doc not found
 */
export function evaluateDocumentLinks<Space extends MemorySpace>(
  session: SpaceStoreSession<Space>,
  docAddress: { id: string; type: string },
  schema: SchemaPathSelector,
  classification?: string[],
  existingSchemaTracker?: MapSet<string, SchemaPathSelector>,
): EvaluateLinksResult | null {
  const providedClassifications = new Set<string>(classification);
  const manager = new ServerObjectManager(session, providedClassifications);
  const tracker = new CompoundCycleTracker<
    Immutable<JSONValue>,
    SchemaContext | undefined
  >();
  const cfc = new ContextualFlowControl();
  // Use existing tracker if provided - enables early termination for already-tracked docs
  const schemaTracker = existingSchemaTracker ??
    new MapSet<string, SchemaPathSelector>(deepEqual);

  // Collect newly discovered links during traversal
  const newLinks: Array<{ docKey: string; schema: SchemaPathSelector }> = [];

  // Load the document
  const address = {
    id: docAddress.id as Entity,
    type: docAddress.type as MIME,
    path: [] as string[],
  };
  const fact = manager.load(address);
  if (fact === null || fact.value === undefined) {
    return null;
  }

  // Create the IAttestation with cause/since (we don't need these for link evaluation)
  const attestation: IAttestation & { cause: CauseString; since: number } = {
    ...fact,
    cause: "" as CauseString, // Not needed for link evaluation
    since: 0,
  };

  // Run the schema traversal to populate schemaTracker with links
  loadFactsForDoc(
    manager,
    attestation,
    schema,
    tracker,
    cfc,
    schemaTracker,
    newLinks,
  );

  return { schemaTracker, newLinks };
}

// The fact passed in is the IAttestation for the top level 'is', so path
// is empty.
function loadFactsForDoc(
  manager: ServerObjectManager,
  fact: IAttestation,
  selector: SchemaPathSelector,
  tracker: PointerCycleTracker,
  cfc: ContextualFlowControl,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  newLinks?: Array<{ docKey: string; schema: SchemaPathSelector }>,
) {
  const factKey = manager.toKey(fact.address);

  // If this doc+schema pair is already tracked, we've already traversed its links
  // so we can skip the entire traversal (early termination optimization)
  if (schemaTracker.hasValue(factKey, selector)) {
    return;
  }

  // Track this doc+schema pair and record it as newly discovered
  schemaTracker.add(factKey, selector);
  if (newLinks !== undefined) {
    newLinks.push({ docKey: factKey, schema: selector });
  }

  if (isObject(fact.value)) {
    if (selector.schemaContext !== undefined) {
      const factValue: IAttestation = {
        address: { ...fact.address, path: [...fact.address.path, "value"] },
        value: (fact.value as Immutable<JSONObject>).value,
      };
      const [newDoc, newSelector] = getAtPath(
        manager,
        factValue,
        selector.path,
        tracker,
        cfc,
        schemaTracker,
        selector,
        newLinks,
      );
      if (newDoc.value === undefined) {
        return;
      }
      // We've provided a schema context for this, so traverse it
      // Pass newLinks to collect any newly discovered docs during traversal
      const traverser = new SchemaObjectTraverser(
        manager,
        newSelector!,
        tracker,
        schemaTracker,
        newLinks,
      );
      // We don't actually use the return value here, but we've built up
      // a list of all the documents we need to watch.
      traverser.traverse(newDoc);
    } else {
      // If we didn't provide a schema context, we still want the selected
      // object in our manager, so load it directly.
      manager.load(fact.address);
      // Note: already tracked at top of function
    }
    // Also load any source links and recipes
    loadSource(manager, fact, new Set<string>(), schemaTracker, newLinks);
  }
}

const redactCommits = <Space extends MemorySpace>(
  includedFacts: FactSelection,
  session: SpaceStoreSession<Space>,
) => {
  const change = getChange(includedFacts, session.subject, COMMIT_LOG_TYPE);
  if (change !== undefined) {
    const [cause, value] = change;
    const commitData = value.is as CommitData;
    // Compute labels for the commit, used to redact classified entries before sending to subscribers
    // For this, we need since fields on our objects to determine labels
    const changedFacts = toSelection(
      commitData.since,
      commitData.transaction.args.changes,
    );
    const labels = getLabels(session, changedFacts);
    // we don't need the since field anymore for these facts
    const redactedData = redactCommitData(commitData, labels);
    const redactedValue = (redactedData !== undefined)
      ? { is: redactedData, since: commitData.since }
      : { since: commitData.since };
    setRevision<FactSelectionValue>(
      includedFacts,
      session.subject,
      COMMIT_LOG_TYPE,
      cause,
      redactedValue,
    );
  }
};

// Adds the ValueEntry's object to the selection, merging the since
// into the `is` field.
function addToSelection(
  includedFacts: FactSelection,
  entry: IAttestation,
  cause: CauseString,
  since: number,
) {
  setRevision(
    includedFacts,
    entry.address.id,
    entry.address.type,
    cause,
    (entry.value !== undefined) ? { is: entry.value, since } : { since },
  );
}

// Get the ValueEntry objects for the facts that match our selector
function* getMatchingFacts<Space extends MemorySpace>(
  session: SpaceStoreSession<Space>,
  factSelector: FactSelector,
): Iterable<IAttestation & { cause: CauseString; since: number }> {
  for (const fact of selectFacts(session, factSelector)) {
    yield {
      value: fact.is,
      address: { id: fact.of, type: fact.the, path: [] },
      cause: fact.cause,
      since: fact.since,
    };
  }
}
