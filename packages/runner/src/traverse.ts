import { refer } from "merkle-reference";
// TODO(@ubik2): Ideally this would use the following, but rollup has issues
//import { isNumber, isObject, isString } from "@commontools/utils/types";
import {
  type Immutable,
  isNumber,
  isObject,
  isRecord,
  isString,
} from "../../utils/src/types.ts";
import { getLogger } from "../../utils/src/logger.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type {
  JSONObject,
  JSONSchema,
  JSONValue,
  SchemaContext,
} from "./builder/types.ts";
import { deepEqual } from "./path-utils.ts";
import { isAnyCellLink, parseLink } from "./link-utils.ts";
import { fromURI } from "./uri-utils.ts";
import type { IAttestation, IMemoryAddress } from "./storage/interface.ts";
import { SchemaAll } from "@commontools/memory/schema";

const logger = getLogger("traverse", { enabled: true, level: "warn" });

export type { IAttestation, IMemoryAddress } from "./storage/interface.ts";

// Both path and schemaContext are relative to the fact.is.value
export type SchemaPathSelector = {
  path: readonly string[];
  schemaContext?: Readonly<SchemaContext>;
};

/**
 * A data structure that maps keys to sets of values, allowing multiple values
 * to be associated with a single key without duplication.
 *
 * @template K The type of keys in the map
 * @template V The type of values stored in the sets
 */
export class MapSet<K, V> {
  private map = new Map<K, Set<V>>();

  public get(key: K): Set<V> | undefined {
    return this.map.get(key);
  }

  public add(key: K, value: V) {
    if (!this.map.has(key)) {
      const values = new Set<V>([value]);
      this.map.set(key, values);
    } else {
      this.map.get(key)!.add(value);
    }
  }

  public has(key: K): boolean {
    return this.map.has(key);
  }

  public hasValue(key: K, value: V): boolean {
    const values = this.map.get(key);
    return (values !== undefined && values.has(value));
  }

  public deleteValue(key: K, value: V): boolean {
    if (!this.map.has(key)) {
      return false;
    } else {
      const values = this.map.get(key)!;
      const rv = values.delete(value);
      if (values.size === 0) {
        this.map.delete(key);
      }
      return rv;
    }
  }

  public delete(key: K) {
    this.map.delete(key);
  }
  /**
   * iterable
   */
  *[Symbol.iterator](): IterableIterator<[K, Set<V>]> {
    for (const [key, values] of this.map) {
      yield [key, values];
    }
  }
}

export const DefaultSchemaSelector = {
  path: [],
  schemaContext: { schema: true, rootSchema: true },
} as const;

export const MinimalSchemaSelector = {
  path: [],
  schemaContext: { schema: false, rootSchema: false },
} as const;

export class CycleTracker<K> {
  private partial: Set<K>;
  private expectCycles: boolean;
  constructor(expectCycles = false) {
    this.expectCycles = expectCycles;
    this.partial = new Set<K>();
  }
  include(k: K, context?: unknown): Disposable | null {
    if (this.partial.has(k)) {
      if (!this.expectCycles) {
        logger.warn(() => [
          "Cycle Detected!",
          k,
          context,
        ]);
      }
      return null;
    }
    this.partial.add(k);
    return {
      [Symbol.dispose]: () => {
        this.partial.delete(k);
      },
    };
  }
}

/**
 * Cycle tracker for more complex objects with multiple parts.
 *
 * This will not work correctly if the key is modified after being added.
 *
 * This will do an identity check on the partial key and a deepEqual check on
 * the ExtraKey.
 */
export class CompoundCycleTracker<PartialKey, ExtraKey> {
  private partial: Map<PartialKey, ExtraKey[]>;
  constructor() {
    this.partial = new Map<PartialKey, ExtraKey[]>();
  }
  include(
    partialKey: PartialKey,
    extraKey: ExtraKey,
    context?: unknown,
  ): Disposable | null {
    let existing = this.partial.get(partialKey);
    if (existing === undefined) {
      existing = [];
      this.partial.set(partialKey, existing);
    }
    if (existing.some((item) => deepEqual(item, extraKey))) {
      logger.warn(() => [
        "Cycle Detected!",
        extraKey,
        context,
      ]);
      return null;
    }
    existing.push(extraKey);
    return {
      [Symbol.dispose]: () => {
        const entries = this.partial.get(partialKey)!;
        const index = entries.indexOf(extraKey);
        if (index === -1) {
          logger.error(() => [
            "Failed to dispose of missing key",
            extraKey,
            context,
          ]);
        }
        if (entries.length === 0) {
          this.partial.delete(partialKey);
        } else {
          entries.splice(index, 1);
        }
      },
    };
  }
}

export type PointerCycleTracker = CompoundCycleTracker<
  Immutable<JSONValue>,
  SchemaContext | undefined
>;

export interface ObjectStorageManager<K, S, V> {
  addRead(address: K, value: V, source: S): void;
  addWrite(address: K, value: V, source: S): void;
  // load the object for the specified key
  load(address: K): IAttestation | null;
}

export type BaseMemoryAddress = Omit<IMemoryAddress, "path">;

// I've really got two different concepts here.
// A. How we traverse the object
//  1. For a schema query, we traverse the object, but avoid visiting branches that don't match our schema
//  2. For a normal traversal, we traverse the object, visiting all child nodes.
// B. How we interact with the objects
//  1. Loading objects from the DB (on the server)
//  2. Loading objects from our memory interface (on the client)

export abstract class BaseObjectManager<
  S extends BaseMemoryAddress,
  V extends JSONValue | undefined,
> implements ObjectStorageManager<BaseMemoryAddress, S, V> {
  constructor(
    protected readValues = new Map<string, IAttestation>(),
    protected writeValues = new Map<string, IAttestation>(),
  ) {}

  addRead(address: S, value: V, source: S) {
    const key = this.toKey(address);
    this.readValues.set(key, {
      value: value,
      address: { path: [], ...source },
    });
  }

  addWrite(address: S, value: V, source: S) {
    const key = this.toKey(address);
    this.writeValues.set(key, {
      value: value,
      address: { path: [], ...source },
    });
  }

  toKey(address: BaseMemoryAddress): string {
    return `${address.id}/${address.type}`;
  }

  toAddress(str: string): BaseMemoryAddress {
    return { id: `of:${str}`, type: "application/json" };
  }

  // load the doc from the underlying system.
  // implementations are responsible for adding this to the readValues
  abstract load(address: BaseMemoryAddress): IAttestation | null;
}

export type OptJSONValue =
  | undefined
  | JSONValue
  | OptJSONArray
  | OptJSONObject;
interface OptJSONArray extends Array<OptJSONValue> {}
interface OptJSONObject {
  [key: string]: OptJSONValue;
}

// Value traversed must be a DAG, though it may have aliases or cell links
// that make it seem like it has cycles
export abstract class BaseObjectTraverser<S extends BaseMemoryAddress> {
  constructor(
    protected manager: BaseObjectManager<S, Immutable<JSONValue> | undefined>,
  ) {}
  abstract traverse(doc: IAttestation): Immutable<OptJSONValue>;

  /**
   * Attempt to traverse the document as a directed acyclic graph.
   * This is the simplest form of traversal, where we include everything.
   *
   * @param doc
   * @param tracker
   * @param schemaTracker
   * @returns
   */
  protected traverseDAG(
    doc: IAttestation,
    tracker: PointerCycleTracker,
    schemaTracker?: MapSet<string, SchemaPathSelector>,
  ): Immutable<JSONValue> | undefined {
    if (isPrimitive(doc.value)) {
      return doc.value;
    } else if (Array.isArray(doc.value)) {
      using t = tracker.include(doc.value, SchemaAll, doc);
      if (t === null) {
        return null;
      }
      return doc.value.map((item, index) =>
        this.traverseDAG(
          {
            ...doc,
            address: {
              ...doc.address,
              path: [...doc.address.path, index.toString()],
            },
            value: item,
          },
          tracker,
          schemaTracker,
        )
      ) as Immutable<JSONValue>[];
    } else if (isRecord(doc.value)) {
      // First, see if we need special handling
      if (isAnyCellLink(doc.value)) {
        const [newDoc, _] = getAtPath(
          this.manager,
          doc,
          [],
          tracker,
          schemaTracker,
          DefaultSchemaSelector,
        );
        if (newDoc.value === undefined) {
          return null;
        }
        return this.traverseDAG(newDoc, tracker, schemaTracker);
      } else {
        using t = tracker.include(doc.value, SchemaAll, doc);
        if (t === null) {
          return null;
        }
        return Object.fromEntries(
          Object.entries(doc.value as JSONObject).map(([k, value]) => [
            k,
            this.traverseDAG(
              {
                ...doc,
                address: { ...doc.address, path: [...doc.address.path, k] },
                value: value,
              },
              tracker,
              schemaTracker,
            ),
          ]),
        ) as Immutable<JSONValue>;
      }
    } else {
      logger.error(() => ["Encountered unexpected object: ", doc.value]);
      return null;
    }
  }
}

/**
 * Traverses a data structure following a path and resolves any pointers.
 * If we load any additional documents, we will also let the helper know.
 *
 * @param manager - Storage manager for document access.
 * @param doc - IAttestation for the current document
 * @param path - Property/index path to follow
 * @param tracker - Prevents pointer cycles
 * @param schemaTracker: Tracks schema used for loaded docs
 * @param selector: The selector being used (its path is relative to doc's root)
 *
 * @returns a tuple containing an IAttestation object with the target doc,
 * docRoot, path, and value and also containing the updated selector that
 * applies to that target doc.
 */
export function getAtPath<S extends BaseMemoryAddress>(
  manager: BaseObjectManager<S, Immutable<JSONValue> | undefined>,
  doc: IAttestation,
  path: readonly string[],
  tracker: PointerCycleTracker,
  schemaTracker?: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
): [IAttestation, SchemaPathSelector | undefined] {
  let curDoc = doc;
  let remaining = [...path];
  while (isAnyCellLink(curDoc.value)) {
    [curDoc, selector] = followPointer(
      manager,
      curDoc,
      remaining,
      tracker,
      schemaTracker,
      selector,
    );
    remaining = [];
  }
  for (
    let part = remaining.shift();
    part !== undefined;
    part = remaining.shift()
  ) {
    if (Array.isArray(curDoc.value)) {
      curDoc = {
        ...curDoc,
        address: { ...curDoc.address, path: [...curDoc.address.path, part] },
        value: elementAt(curDoc.value, part),
      };
    } else if (
      isObject(curDoc.value) && part in (curDoc.value as Immutable<JSONObject>)
    ) {
      const cursorObj = curDoc.value as Immutable<JSONObject>;
      curDoc = {
        ...curDoc,
        address: { ...curDoc.address, path: [...curDoc.address.path, part] },
        value: cursorObj[part] as Immutable<JSONValue>,
      };
    } else {
      // we can only descend into pointers, objects, and arrays
      return [{
        ...curDoc,
        address: { ...curDoc.address, path: [] },
        value: undefined,
      }, selector];
    }
    // If this next value is a pointer, use the pointer resolution code
    while (isAnyCellLink(curDoc.value)) {
      [curDoc, selector] = followPointer(
        manager,
        curDoc,
        remaining,
        tracker,
        schemaTracker,
        selector,
      );
      remaining = [];
    }
  }
  return [curDoc, selector];
}

function notFound(address: BaseMemoryAddress): IAttestation {
  return {
    address: { ...address, path: [] },
    value: undefined,
  };
}
/**
 * Resolves a pointer reference to its target value.
 *
 * @param manager - Object storage manager for document access
 * @param doc - IAttestation for the current document
 * @param path - Property/index path to follow
 * @param tracker - Prevents infinite pointer cycles
 * @param schemaTracker: Tracks schema to use for loaded docs
 * @param selector?: SchemaPathSelector used to query the target doc
 *
 * @returns an IAttestation object with the target doc, docRoot, path, and value.
 */
function followPointer<S extends BaseMemoryAddress>(
  manager: BaseObjectManager<S, Immutable<JSONValue> | undefined>,
  doc: IAttestation,
  path: readonly string[],
  tracker: PointerCycleTracker,
  schemaTracker?: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
): [IAttestation, SchemaPathSelector | undefined] {
  const link = parseLink(doc.value)!;
  const target: BaseMemoryAddress = (link.id !== undefined)
    ? { id: link.id, type: "application/json" }
    : doc.address;
  const targetDoc = {
    address: doc.address,
    value: doc.value,
  };
  if (selector !== undefined) {
    // We'll need to re-root the selector for the target doc
    // Remove the portions of doc.path from selector.path, limiting schema if
    // needed.
    // Also insert the portions of cellTarget.path, so selector is relative to
    // new target doc. We do this even if the target doc is the same doc, since
    // we want the selector path to match.
    // We also remove the initial "value" from the doc path, since that won't
    // be included in the selector or link path.
    selector = narrowSchema(
      doc.address.path.slice(1),
      selector,
      link.path as string[],
    );
  }
  using t = tracker.include(doc.value!, selector?.schemaContext, doc);
  if (t === null) {
    // Cycle detected - treat this as notFound to avoid traversal
    return [notFound(doc.address), selector];
  }
  if (link.id !== undefined) {
    // We have a reference to a different cell, so track the dependency
    // and update our targetDoc
    const valueEntry = manager.load(target);
    if (valueEntry === null) {
      return [notFound(doc.address), selector];
    }
    if (schemaTracker !== undefined && selector !== undefined) {
      schemaTracker.add(manager.toKey(target), selector);
    }
    // If the object we're pointing to is a retracted fact, just return undefined.
    // We can't do a better match, but we do want to include the result so we watch this doc
    if (valueEntry.value === undefined) {
      return [notFound(target), selector];
    }
    // Otherwise, we can continue with the target.
    // an assertion fact.is will be an object with a value property, and
    // that's what our schema is relative to.
    targetDoc.address = { ...target, path: ["value"] };
    targetDoc.value = (valueEntry.value as Immutable<JSONObject>)["value"];
    // Load any sources (recursively) if they exist and any linked recipes
    loadSource(
      manager,
      valueEntry,
      new Set<string>(),
      schemaTracker,
    );
  }

  // We've loaded the linked doc, so walk the path to get to the right part of that doc (or whatever doc that path leads to),
  // then the provided path from the arguments.
  return getAtPath(
    manager,
    {
      address: targetDoc.address,
      value: targetDoc.value,
    },
    [...link.path, ...path] as string[],
    tracker,
    schemaTracker,
    selector,
  );
}

// Recursively load the source from the doc ()
// This will also load any recipes linked by the doc.
export function loadSource<S extends BaseMemoryAddress>(
  manager: BaseObjectManager<S, Immutable<JSONValue> | undefined>,
  valueEntry: IAttestation,
  cycleCheck: Set<string> = new Set<string>(),
  schemaTracker?: MapSet<string, SchemaPathSelector>,
) {
  loadLinkedRecipe(manager, valueEntry, schemaTracker);
  if (!isObject(valueEntry.value)) {
    return;
  }
  const targetObj = valueEntry.value as Immutable<JSONObject>;
  if (!(isObject(targetObj) || !("source" in targetObj))) {
    return;
  }
  // We also want to include the source cells
  const source = targetObj["source"];
  if (!isObject(source) || !("/" in source) || !isString(source["/"])) {
    // undefined is strange, but acceptable
    if (source !== undefined) {
      logger.warn(
        () => ["Invalid source link", source, "in", valueEntry.address],
      );
    }
    return;
  }
  const of: string = source["/"];
  if (cycleCheck.has(of)) {
    return;
  }
  cycleCheck.add(of);
  const address = manager.toAddress(of);
  const entry = manager.load(address);
  if (entry === null || entry.value === undefined) {
    return;
  }
  if (schemaTracker !== undefined) {
    schemaTracker.add(manager.toKey(address), MinimalSchemaSelector);
  }
  loadSource(manager, entry, cycleCheck, schemaTracker);
}

// Load the linked recipe from the doc ()
// We don't recurse, since that's not required for recipe links
function loadLinkedRecipe<S extends BaseMemoryAddress>(
  manager: BaseObjectManager<S, Immutable<JSONValue> | undefined>,
  valueEntry: IAttestation,
  schemaTracker?: MapSet<string, SchemaPathSelector>,
) {
  if (!isObject(valueEntry.value)) {
    return;
  }
  const targetObj = valueEntry.value as Immutable<JSONObject>;
  if (!(isObject(targetObj) || !("value" in targetObj))) {
    return;
  }
  // We also want to include the source cells
  const value = targetObj["value"];
  if (!isObject(value)) {
    return;
  }
  let address;
  // Check for a spell link first, since this is more efficient
  // Older recipes will only have a $TYPE
  if ("spell" in value && isAnyCellLink(value["spell"])) {
    const link = parseLink(value["spell"])!;
    address = manager.toAddress(fromURI(link.id!));
  } else if ("$TYPE" in value && isString(value["$TYPE"])) {
    const recipeId = value["$TYPE"];
    const entityId = refer({ causal: { recipeId, type: "recipe" } });
    address = manager.toAddress(entityId.toJSON()["/"]);
  }
  if (address === undefined) {
    return;
  }
  const entry = manager.load(address);
  if (entry === null || entry.value === undefined) {
    return;
  }
  if (schemaTracker !== undefined) {
    schemaTracker.add(manager.toKey(address), MinimalSchemaSelector);
  }
}

// docPath is where we found the pointer and are doing this work. It does not
// include the initial "value" portion.
// Selector path and schema used to be relative to the "value" of the doc, but
// we want them relative to the "value" of the new doc.
// targetPath is the path in the target doc that the pointer points to -- the
// targetPath does not include the initial "value"
function narrowSchema(
  docPath: readonly string[],
  selector: SchemaPathSelector,
  targetPath: readonly string[],
): SchemaPathSelector {
  let pathIndex = 0;
  while (pathIndex < docPath.length && pathIndex < selector.path.length) {
    if (docPath[pathIndex] !== selector.path[pathIndex]) {
      logger.warn(() => ["Mismatched paths", docPath, selector.path]);
      return MinimalSchemaSelector;
    }
    pathIndex++;
  }
  if (pathIndex < docPath.length) {
    // we've reached the end of our selector path, but still have parts in our doc path, so narrow the schema
    // Some of the schema may have been applicable to other parts of the doc, but we only want to use the
    // portion that will apply to the next doc.
    const cfc = new ContextualFlowControl();
    const schema = cfc.schemaAtPath(
      selector.schemaContext!.schema,
      docPath.slice(pathIndex),
      selector.schemaContext!.rootSchema,
    );
    return {
      path: [...targetPath],
      schemaContext: {
        schema: schema,
        rootSchema: selector.schemaContext!.rootSchema,
      },
    };
  } else {
    // We've reached the end of the doc path, but may still have stuff in our
    // selector path, so remove the path parts we've already walked from the
    // selector.
    return {
      path: [...targetPath, ...selector.path.slice(docPath.length)],
      schemaContext: selector.schemaContext,
    };
  }
}

function indexFromPath(
  array: unknown[],
  path: string,
): number | undefined {
  const number = new Number(path).valueOf();
  return (Number.isInteger(number) && number >= 0 && number < array.length)
    ? number
    : undefined;
}

function elementAt<T>(array: T[], path: string): T | undefined {
  const index = indexFromPath(array, path);
  return (index === undefined) ? undefined : array[index];
}

type Primitive = string | number | boolean | null | undefined | symbol | bigint;

export function isPrimitive(val: unknown): val is Primitive {
  const type = typeof val;
  return val === null || (type !== "object" && type !== "function");
}

export class SchemaObjectTraverser<S extends BaseMemoryAddress>
  extends BaseObjectTraverser<S> {
  constructor(
    manager: BaseObjectManager<S, Immutable<JSONValue> | undefined>,
    private selector: SchemaPathSelector,
    private tracker: PointerCycleTracker = new CompoundCycleTracker<
      Immutable<JSONValue>,
      SchemaContext | undefined
    >(),
    private schemaTracker: MapSet<string, SchemaPathSelector> = new MapSet<
      string,
      SchemaPathSelector
    >(),
  ) {
    super(manager);
  }

  override traverse(
    doc: IAttestation,
  ): Immutable<OptJSONValue> {
    this.schemaTracker.add(this.manager.toKey(doc.address), this.selector);
    return this.traverseWithSelector(doc, this.selector);
  }

  // Traverse the specified doc with the selector.
  // The selector should have been re-rooted if needed to be relative to the specified doc
  // The selector must have a valid (defined) schemaContext
  traverseWithSelector(
    doc: IAttestation,
    selector: SchemaPathSelector,
  ): Immutable<OptJSONValue> {
    // Remove the leading "value" from the doc's address for comparison with
    // the schema path (which does not include the "value" portion).
    const valuePath = doc.address.path.slice(1);
    if (deepEqual(valuePath, selector.path)) {
      return this.traverseWithSchemaContext(doc, selector.schemaContext!);
    } else if (valuePath.length > selector.path.length) {
      throw new Error("Doc path should never exceed selector path");
    } else if (
      !deepEqual(valuePath, selector.path.slice(0, valuePath.length))
    ) {
      // There's a mismatch in the initial part, so this will not match
      return undefined;
    } else { // valuePath length < selector.path.length
      const [nextDoc, nextSelector] = getAtPath(
        this.manager,
        doc,
        selector.path.slice(valuePath.length),
        this.tracker,
        this.schemaTracker,
        selector,
      );
      if (nextDoc.value === undefined) {
        return undefined;
      }
      const nextValuePath = nextDoc.address.path.slice(1);
      if (!deepEqual(nextValuePath, nextSelector!.path)) {
        throw new Error("New doc path doesn't match selector path");
      }
      return this.traverseWithSchemaContext(
        nextDoc,
        nextSelector!.schemaContext!,
      );
    }
  }

  traverseWithSchemaContext(
    doc: IAttestation,
    schemaContext: Readonly<SchemaContext>,
  ): Immutable<OptJSONValue> {
    if (ContextualFlowControl.isTrueSchema(schemaContext.schema)) {
      // A value of true or {} means we match anything
      // Resolve the rest of the doc, and return
      return this.traverseDAG(doc, this.tracker, this.schemaTracker);
    } else if (schemaContext.schema === false) {
      // This value rejects all objects - just return
      return undefined;
    } else if (typeof schemaContext.schema !== "object") {
      logger.warn(
        () => ["Invalid schema is not an object", schemaContext.schema],
      );
      return undefined;
    }
    if ("$ref" in schemaContext.schema) {
      const schemaRef = schemaContext.schema["$ref"];
      if (!isObject(schemaContext.rootSchema)) {
        logger.warn(
          () => ["Unsupported $ref without root schema object: ", schemaRef],
        );
        return undefined;
      } else if (typeof schemaRef !== "string") {
        logger.warn(
          () => ["Invalid non-string $ref", schemaContext.schema, schemaRef],
        );
        return undefined;
      }
      const resolved = ContextualFlowControl.resolveSchemaRef(
        schemaContext.rootSchema,
        schemaRef,
      );
      if (resolved === undefined) {
        return undefined;
      }
      schemaContext = {
        schema: resolved,
        rootSchema: schemaContext.rootSchema,
      };
    }
    const schemaObj = schemaContext.schema as Immutable<JSONObject>;
    if (doc.value === null) {
      return this.isValidType(schemaObj, "null") ? doc.value : undefined;
    } else if (isString(doc.value)) {
      return this.isValidType(schemaObj, "string") ? doc.value : undefined;
    } else if (isNumber(doc.value)) {
      return this.isValidType(schemaObj, "number") ? doc.value : undefined;
    } else if (Array.isArray(doc.value)) {
      if (this.isValidType(schemaObj, "array")) {
        using t = this.tracker.include(doc.value, schemaContext, doc);
        if (t === null) {
          return null;
        }
        return this.traverseArrayWithSchema(doc, {
          schema: schemaObj,
          rootSchema: schemaContext.rootSchema,
        });
      }
      return undefined;
    } else if (isObject(doc.value)) {
      if (isAnyCellLink(doc.value)) {
        return this.traversePointerWithSchema(doc, {
          schema: schemaObj,
          rootSchema: schemaContext.rootSchema,
        });
      } else if (this.isValidType(schemaObj, "object")) {
        using t = this.tracker.include(doc.value, schemaContext, doc);
        if (t === null) {
          return null;
        }
        return this.traverseObjectWithSchema(doc, {
          schema: schemaObj,
          rootSchema: schemaContext.rootSchema,
        });
      }
    }
  }

  private isValidType(
    schemaObj: Immutable<JSONObject>,
    valueType: string,
  ): boolean {
    if ("type" in schemaObj) {
      if (Array.isArray(schemaObj["type"])) {
        return schemaObj["type"].includes(valueType);
      } else if (isString(schemaObj["type"])) {
        return schemaObj["type"] === valueType;
      } else {
        // invalid schema type
        return false;
      }
    }
    return true;
  }

  private traverseArrayWithSchema(
    doc: IAttestation,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const arrayObj = [];
    const schema = schemaContext.schema as Immutable<JSONObject>;
    for (
      const [index, item] of (doc.value as Immutable<JSONValue>[]).entries()
    ) {
      const itemSchema = isObject(schema["items"])
        ? schema["items"] as JSONSchema
        : typeof (schema["items"]) === "boolean"
        ? schema["items"]
        : true;
      const curDoc = {
        ...doc,
        address: {
          ...doc.address,
          path: [...doc.address.path, index.toString()],
        },
        value: item,
      };
      // Selector paths don't include the initial "value"
      const selector = {
        path: curDoc.address.path.slice(1),
        schemaContext: {
          schema: itemSchema,
          rootSchema: schemaContext.rootSchema,
        },
      };
      const val = this.traverseWithSelector(curDoc, selector);
      if (val === undefined) {
        // this array is invalid, since one or more items do not match the schema
        return undefined;
      }
      arrayObj.push(val);
    }
    return arrayObj;
  }

  private traverseObjectWithSchema(
    doc: IAttestation,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const filteredObj: Record<string, Immutable<OptJSONValue>> = {};
    const schema = schemaContext.schema as Immutable<JSONObject>;
    for (const [propKey, propValue] of Object.entries(doc.value!)) {
      const schemaProperties = schema["properties"] as
        | Record<string, JSONSchema>
        | undefined;
      const propSchema =
        (isObject(schemaProperties) && propKey in schemaProperties)
          ? schemaProperties[propKey]
          : (isObject(schema["additionalProperties"]) ||
              typeof schema["additionalProperties"] === "boolean")
          ? schema["additionalProperties"] as JSONSchema
          : undefined;
      // Normally, if additionalProperties is not specified, it would
      // default to true. However, we treat this specially, where we
      // don't invalidate the object, but also don't descend down
      // into that property.
      if (propSchema === undefined) {
        filteredObj[propKey] = propValue;
        continue;
      }
      const val = this.traverseWithSchemaContext({
        ...doc,
        address: {
          ...doc.address,
          path: [...doc.address.path, propKey],
        },
        value: propValue,
      }, {
        schema: propSchema,
        rootSchema: schemaContext.rootSchema,
      });
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

  // This just has a schemaContext, since the portion of the doc.address.path
  // after "value" would match the selector.path.
  private traversePointerWithSchema(
    doc: IAttestation,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const selector = {
      path: [...doc.address.path.slice(1)],
      schemaContext: schemaContext,
    };
    const [newDoc, newSelector] = getAtPath(
      this.manager,
      doc,
      [],
      this.tracker,
      this.schemaTracker,
      selector,
    );
    if (newDoc.value === undefined) {
      return null;
    }
    // The call to getAtPath above will track entry into the pointer,
    // but we may have a pointer cycle of docs, and we've finished resolving
    // the pointer now. To avoid descending into a cycle, track entry to the
    // doc we were called with (not the one we resolved, which may be a pointer).
    using t = this.tracker.include(doc.value!, schemaContext, doc);
    if (t === null) {
      return null;
    }
    return this.traverseWithSelector(newDoc, newSelector!);
  }
}

/**
 * Is schemaA a superset of schemaB.
 * That is, will every object matched by schema B also be matched by schemaA.
 *
 * @param schemaA
 * @param schemaB
 * @returns true if schemaA is a superset, or false if it cannot be determined.
 */
// TDDO(@ubik2): In cache.ts, we have a SelectorTracker which does more
// sophisticated matching. Break that out into a schema module so we can use
// that logic here.
export function isSchemaSuperset(
  schemaA: JSONSchema,
  schemaB: JSONSchema,
) {
  return (ContextualFlowControl.isTrueSchema(schemaA)) ||
    deepEqual(schemaA, schemaB) || (schemaB === false);
}
