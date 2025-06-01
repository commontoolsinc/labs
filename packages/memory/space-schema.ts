import type {
  Cause,
  Entity,
  FactSelection,
  MemorySpace,
  SchemaQuery,
  SchemaSelector,
} from "./interface.ts";
import { SelectAllString } from "./interface.ts";
import { isObject } from "@commontools/utils/types";
import {
  collectClassifications,
  FactSelectionValue,
  FactSelector,
  getClassifications,
  getLabel,
  getLabels,
  loadFacts,
  redactCommitData,
  SelectedFact,
  selectFacts,
  Session,
  toSelection,
} from "./space.ts";
import { FactAddress } from "../runner/src/storage/cache.ts";
import {
  BaseObjectManager,
  CellTarget,
  CycleTracker,
  getAtPath,
  SchemaObjectTraverser,
  ValueEntry,
} from "./traverse.ts";
import { JSONObject, JSONSchema, JSONValue } from "@commontools/builder";
import { TheAuthorizationError } from "./error.ts";
import {
  getChange,
  getRevision,
  getSelectorRevision,
  iterate,
  iterateSelector,
  setEmptyObj,
  setRevision,
} from "./selection.ts";
import { the as COMMIT_THE } from "./commit.ts";
import { CommitData } from "./consumer.ts";
export type * from "./interface.ts";
export * from "./interface.ts";

type FullFactAddress = FactAddress & { cause: Cause; since: number };

export class ServerTraverseHelper extends BaseObjectManager<
  FactAddress,
  FullFactAddress,
  JSONValue | undefined
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
  // Returns undefined if we have a retraction for that object
  load(
    doc: FactAddress,
  ): ValueEntry<FullFactAddress, JSONValue | undefined> | null {
    const key = this.toKey(doc);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    } else if (this.restrictedValues.has(key)) {
      return null;
    }
    const factSelector: FactSelector = {
      of: doc.of,
      the: doc.the,
      cause: SelectAllString,
    };
    // we should only have one match
    for (const fact of selectFacts(this.session, factSelector)) {
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
): FactSelection => {
  const factSelection: FactSelection = {}; // we'll store our initial facts here
  const includedFacts: FactSelection = {}; // we'll store all the raw facts we accesed here
  // First, collect all the potentially relevant facts (without dereferencing pointers)
  for (const entry of iterateSelector(selectSchema)) {
    const factSelector = {
      of: entry.of,
      the: entry.the,
      cause: entry.cause,
      since,
      ...entry.value.is ? { is: entry.value.is } : {},
    };
    loadFacts(factSelection, session, factSelector);
  }

  // All the top level facts we accessed should be included
  for (const entry of iterate(factSelection)) {
    setRevision(includedFacts, entry.of, entry.the, entry.cause, entry.value);
  }

  const providedClassifications = new Set<string>(classification);

  // Track any docs loaded while traversing the factSelection
  const helper = new ServerTraverseHelper(session, providedClassifications);
  // Then filter the facts by the associated schemas, which will dereference
  // pointers as we walk through the structure.
  loadDocFacts(helper, selectSchema, includedFacts);

  // Add any facts that we accessed while traversing the object with its schema
  // We'll need the same set of objects on the client to traverse it there.
  for (const value of helper.getReadDocs()) {
    if (value.source === undefined) {
      continue;
    }
    setRevision(
      includedFacts,
      value.source.of,
      value.source.the,
      value.source.cause,
      (value.value !== undefined)
        ? { is: value.value, since: value.source.since }
        : { since: value.source.since },
    );
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
  for (const factSelector of iterateSelector(selectSchema)) {
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

function loadDocFacts(
  helper: ServerTraverseHelper,
  selectSchema: SchemaSelector,
  factSelection: FactSelection,
) {
  const tracker = new CycleTracker<JSONValue>();
  for (const fact of iterate(factSelection)) {
    const selector = getSelectorRevision(selectSchema, fact.of, fact.the);
    if (selector === undefined) {
      continue;
    }
    if (isObject(fact.value.is)) {
      const factAddress = { the: fact.the, of: fact.of };
      if (selector.schemaContext !== undefined) {
        const factValue = (fact.value.is as JSONObject).value;
        const [newDoc, newDocRoot, newValue] = getAtPath<
          FactAddress,
          FullFactAddress
        >(helper, factAddress, factValue, factValue, selector.path, tracker);
        if (newValue === undefined) {
          continue;
        }
        // We've provided a schema context for this, so traverse it
        const traverser = new SchemaObjectTraverser(
          helper,
          selector.schemaContext,
          selector.schemaContext.rootSchema,
          tracker,
        );
        // We don't actually use the return value here, but we've built up
        // a list of all the documents we need to watch.
        traverser.traverse(newDoc, newDocRoot, newValue);
      } else {
        // If we didn't provide a schema context, we still want the selected
        // object in our helper, so load it directly.
        helper.load(factAddress);
      }
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
