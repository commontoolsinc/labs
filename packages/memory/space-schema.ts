import type {
  Cause,
  Entity,
  FactSelection,
  MemorySpace,
  SchemaContext,
  SchemaQuery,
  SchemaSelector,
} from "./interface.ts";
import { SelectAllString } from "./interface.ts";
import { isNumber, isObject, isString } from "@commontools/utils/types";
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
  BaseObjectTraverser,
  CellTarget,
  CycleTracker,
  getAtPath,
  isPointer,
  ObjectStorageManager,
  OptJSONValue,
  ValueEntry,
} from "./traverse.ts";
import { JSONObject, JSONSchema, JSONValue } from "@commontools/builder";
import { ContextualFlowControl } from "@commontools/runner";
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

export class SchemaObjectTraverser<K, S> extends BaseObjectTraverser<K, S> {
  constructor(
    helper: ObjectStorageManager<K, S, JSONValue>,
    private schemaContext: SchemaContext,
    private rootSchema: JSONSchema | boolean | undefined = undefined,
    private tracker: CycleTracker<JSONValue> = new CycleTracker<JSONValue>(),
  ) {
    super(helper);
    this.rootSchema = schemaContext.rootSchema;
  }

  traverse(
    doc: K,
    docRoot: JSONValue,
    value: JSONValue,
  ): OptJSONValue {
    return this.traverseWithSchema(
      doc,
      docRoot,
      value,
      this.schemaContext.schema,
    );
  }

  traverseWithSchema(
    doc: K,
    docRoot: JSONValue,
    value: JSONValue,
    schema: JSONSchema | boolean,
  ): OptJSONValue {
    if (ContextualFlowControl.isTrueSchema(schema)) {
      // A value of true or {} means we match anything
      // Resolve the rest of the doc, and return
      return this.traverseDAG(doc, docRoot, value, this.tracker);
    } else if (schema === false) {
      // This value rejects all objects - just return
      return undefined;
    } else if (typeof schema !== "object") {
      console.warn("Invalid schema is not an object", schema);
      return undefined;
    }
    if ("$ref" in schema) {
      // At some point, this should be extended to support more than just '#'
      if (schema["$ref"] != "#") {
        console.warn("Unsupported $ref in schema: ", schema["$ref"]);
      }
      if (this.rootSchema === undefined) {
        console.warn("Unsupported $ref without root schema: ", schema["$ref"]);
        return undefined;
      }
      schema = this.rootSchema;
    }
    const schemaObj = schema as JSONObject;
    if (value === null) {
      return ("type" in schemaObj && schemaObj["type"] == "null")
        ? value
        : undefined;
    } else if (isString(value)) {
      return ("type" in schemaObj && schemaObj["type"] == "string")
        ? value
        : undefined;
    } else if (isNumber(value)) {
      return ("type" in schemaObj && schemaObj["type"] == "number")
        ? value
        : undefined;
    } else if (Array.isArray(value)) {
      if ("type" in schemaObj && schemaObj["type"] == "array") {
        if (this.tracker.enter(value)) {
          try {
            this.traverseArrayWithSchema(doc, docRoot, value, schemaObj);
          } finally {
            this.tracker.exit(value);
          }
        } else {
          console.log("Cycle detected", JSON.stringify(doc));
          return null;
        }
      }
      return undefined;
    } else if (isObject(value)) {
      if (isPointer(value)) {
        return this.traversePointerWithSchema(
          doc,
          docRoot,
          value as JSONObject,
          schemaObj,
        );
        // TODO(@ubik2): it might be technically ok to follow the same pointer more than once, since we might have
        // a different schema the second time, which could prevent an infinite cycle, but for now, just reject these.
      } else if ("type" in schemaObj && schemaObj["type"] == "object") {
        if (this.tracker.enter(value)) {
          try {
            this.traverseObjectWithSchema(
              doc,
              docRoot,
              value as JSONObject,
              schemaObj,
            );
          } finally {
            this.tracker.exit(value);
          }
        } else {
          console.log("Cycle detected", JSON.stringify(doc));
          return null;
        }
      }
    }
  }

  private traverseArrayWithSchema(
    doc: K,
    docRoot: JSONValue,
    value: JSONValue[],
    schema: JSONSchema,
  ): OptJSONValue {
    const arrayObj = [];
    for (const item of value) {
      const itemSchema = isObject(schema["items"])
        ? schema["items"] as JSONSchema
        : typeof (schema["items"]) === "boolean"
        ? schema["items"]
        : true;
      const val = this.traverseWithSchema(doc, docRoot, item, itemSchema);
      if (val === undefined) {
        // this array is invalid, since one or more items do not match the schema
        return undefined;
      }
      arrayObj.push(val);
    }
    return arrayObj;
  }

  private traverseObjectWithSchema(
    doc: K,
    docRoot: JSONValue,
    value: JSONObject,
    schema: JSONSchema,
  ): OptJSONValue {
    const filteredObj: Record<string, OptJSONValue> = {};
    for (const [propKey, propValue] of Object.entries(value)) {
      const schemaProperties = schema["properties"] as
        | Record<string, JSONSchema | boolean>
        | undefined;
      const propSchema = (
          isObject(schemaProperties) &&
          schemaProperties !== undefined &&
          propKey in schemaProperties
        )
        ? schemaProperties[propKey]
        : (isObject(schema["additionalProperties"]) ||
            schema["additionalProperties"] === false)
        ? schema["additionalProperties"] as JSONSchema | boolean
        : true;
      const val = this.traverseWithSchema(doc, docRoot, propValue, propSchema);
      if (val !== undefined) {
        filteredObj[propKey] = val;
      }
    }
    // Check that all required fields are present
    if ("required" in schema) {
      const required = schema["required"] as string[];
      if (Array.isArray(required)) {
        for (const requiredProperty of required) {
          if (!(requiredProperty in filteredObj)) {
            return undefined;
          }
        }
      }
    }
    return filteredObj;
  }

  private traversePointerWithSchema(
    doc: K,
    docRoot: JSONValue,
    value: JSONObject,
    schema: JSONSchema,
  ): OptJSONValue {
    const [newDoc, newDocRoot, newObj] = getAtPath(
      this.helper,
      doc,
      docRoot,
      value,
      [],
      this.tracker,
    );
    if (newObj === undefined) {
      return null;
    }
    if (this.tracker.enter(value)) {
      try {
        return this.traverseWithSchema(newDoc, newDocRoot, newObj, schema);
      } finally {
        this.tracker.exit(value);
      }
    } else {
      console.log("Cycle detected", JSON.stringify(doc));
      return null;
    }
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
