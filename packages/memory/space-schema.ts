import {
  ContextualFlowControl,
  deepEqual,
  type JSONObject,
  type JSONSchema,
} from "@commontools/runner";
import type { StorableDatum } from "./interface.ts";
import {
  type BaseMemoryAddress,
  CompoundCycleTracker,
  getAtPath,
  type IAttestation,
  loadSource,
  ManagedStorageTransaction,
  MapSet,
  type ObjectStorageManager,
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
import {
  getChange,
  getRevision,
  iterate,
  iterateSelector,
  SelectAllString,
  setEmptyObj,
  setRevision,
} from "./selection.ts";
import {
  collectClassifications,
  type FactSelectionValue,
  type FactSelector,
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
import { ExtendedStorageTransaction } from "../runner/src/storage/extended-storage-transaction.ts";
import { IMemorySpaceAttestation } from "../runner/src/storage/interface.ts";

export type * from "./interface.ts";

const logger = getLogger("space-schema", {
  enabled: false,
  level: "info",
});

// This class is used to manage the underlying objects in storage, so the
// class that traverses the docs doesn't need to know the implementation.
// It also lets us use one system on the server (where we have the sqlite db)
// and another system on the client.
export class ServerObjectManager implements ObjectStorageManager {
  private readValues = new Map<string, IAttestation>();
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
  }

  /**
   * Load the facts for the provided address
   *
   * @param address the address of the fact to load
   * @returns an IAttestation with the value for the specified doc,
   * null if there is no matching fact, or undefined if there is a retraction.
   */
  load(address: BaseMemoryAddress): IAttestation | null {
    const key = `${address.id}/${address.type}`;
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
      this.factDetails.set(key, { cause: fact.cause, since: fact.since });
      this.readValues.set(key, valueEntry);
      return valueEntry;
    }
    return null;
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getDetails(address: BaseMemoryAddress) {
    const key = `${address.id}/${address.type}`;
    return this.factDetails.get(key);
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
    Immutable<StorableDatum>,
    JSONSchema | undefined
  >();
  const cfc = new ContextualFlowControl();
  // Use existing tracker if provided, otherwise create new one
  const schemaTracker = existingSchemaTracker ??
    new MapSet<string, SchemaPathSelector>(deepEqual);

  const includedFacts: FactSelection = {}; // we'll store all the raw facts we accesed here
  // First, collect all the potentially relevant facts (without dereferencing pointers)
  // The value in these selectorEntry objects doesn't have the "value" in path yet.
  for (
    const selectorEntry of iterateSelector(
      selectSchema,
      { path: [], schemaContext: { schema: true } },
    )
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
      // These selectorEntry objects in SchemaQuery have their path relative
      // to the value, but our traversal wants them to be relative to the
      // fact.is, so adjust the paths.
      const selector: SchemaPathSelector = {
        schema: selectorEntry.value.schemaContext?.schema,
        path: ["value", ...selectorEntry.value.path],
      };
      // Then filter the facts by the associated schemas, which will dereference
      // pointers as we walk through the structure.
      loadFactsForDoc(
        manager,
        entry,
        selector,
        tracker,
        cfc,
        session.subject,
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
    const factSelector of iterateSelector(
      selectSchema,
      { path: [], schemaContext: { schema: true } },
    )
  ) {
    if (
      factSelector.of !== SelectAllString &&
      factSelector.the !== SelectAllString
    ) {
      // Track all specifically-queried entities in schemaTracker so incremental
      // updates can detect changes to them, even if they don't have data yet
      const docKey =
        `${session.subject}/${factSelector.of}/${factSelector.the}`;
      // These selectorEntry objects in SchemaQuery have their path relative
      // to the value, but our traversal wants them to be relative to the
      // fact.is, so adjust the paths.
      const selector = {
        ...factSelector.value,
        path: ["value", ...factSelector.value.path],
      };
      schemaTracker.add(docKey, selector);

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

/**
 * Evaluates a single document with a schema and returns the links it contains.
 * Used for incremental subscription updates - when a document changes, we re-evaluate
 * that document (and reachable documents) to find what links it now has.
 *
 * @param session - The space store session
 * @param address - The document to evaluate (space, id, and type)
 * @param schemaSelector - The schema to apply
 * @param classification - Classification claims for access control
 * @returns The updated schemaTracker
 */
export function evaluateDocumentLinks<Space extends MemorySpace>(
  session: SpaceStoreSession<Space>,
  address: { space: MemorySpace; id: Entity; type: MIME },
  schemaSelector: SchemaPathSelector,
  classification: string[],
  schemaTracker: MapSet<string, SchemaPathSelector>,
): MapSet<string, SchemaPathSelector> {
  const providedClassifications = new Set<string>(classification);
  const manager = new ServerObjectManager(session, providedClassifications);
  const tracker = new CompoundCycleTracker<
    Immutable<StorableDatum>,
    JSONSchema | undefined
  >();
  const cfc = new ContextualFlowControl();

  // Load the document
  const fact = manager.load(address);
  if (fact === null || fact.value === undefined) {
    // If the fact doesn't exist, we still want to add it to the
    // schemaTracker, so we get updates when the fact is added.
    const factKey = `${address.space}/${address.id}/${address.type}`;
    schemaTracker.add(factKey, schemaSelector);
    return schemaTracker;
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
    schemaSelector,
    tracker,
    cfc,
    session.subject,
    schemaTracker,
  );

  return schemaTracker;
}

// The fact passed in is the IAttestation for the top level 'is', so path
// is empty.
// The selector should typically have a path starting with value
function loadFactsForDoc(
  manager: ServerObjectManager,
  fact: IAttestation,
  selector: SchemaPathSelector,
  tracker: PointerCycleTracker,
  cfc: ContextualFlowControl,
  space: MemorySpace,
  schemaTracker: MapSet<string, SchemaPathSelector>,
) {
  // A query without a schema context is the same as a query with the minimal schema
  // This will match the specified document, but no linked documents
  if (selector.schema === undefined) {
    selector = { ...selector, schema: false };
  }

  // If this doc+schema pair is already tracked, we've already traversed its links
  // so we can skip the entire traversal (early termination optimization)
  const factKey = `${space}/${fact.address.id}/${fact.address.type}`;
  if (schemaTracker.hasValue(factKey, selector)) {
    return;
  }

  // Track this doc+schema pair and record it as newly discovered
  schemaTracker.add(factKey, selector);

  if (isObject(fact.value)) {
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    if (selector.schema !== false) {
      const factValue: IMemorySpaceAttestation = {
        address: { ...fact.address, space: space },
        value: (fact.value as Immutable<JSONObject>),
      };
      if (fact.address.path.length > 0) {
        throw new Error("Invalid fact.address.path (must be empty)");
      }
      const [newDoc, newSelector] = getAtPath(
        tx,
        factValue,
        selector.path,
        tracker,
        cfc,
        schemaTracker,
        selector,
      );
      if (newDoc.value === undefined) {
        return;
      }
      // We've provided a schema context for this, so traverse it
      const traverser = new SchemaObjectTraverser(
        tx,
        newSelector!,
        tracker,
        schemaTracker,
        cfc,
        undefined,
        // FIXME(@ubik2): I think this should be true, but not part of this PR
        undefined,
      );
      // We don't actually use the return value here, but we've built up
      // a list of all the documents we need to watch.
      traverser.traverse(newDoc);
    } else {
      // If we didn't provide a schema context, we still want the selected
      // object in our manager, so load it directly.
      manager.load(fact.address);
    }
    // Also load any source links and recipes
    const fullAddress = { ...fact.address, space: space };
    loadSource(
      tx,
      { address: fullAddress, value: fact.value },
      new Set<string>(),
      schemaTracker,
    );
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
