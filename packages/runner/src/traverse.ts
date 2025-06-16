// TODO(@ubik2): Ideally this would use the following, but rollup has issues
//import { isNumber, isObject, isString } from "@commontools/utils/types";
import {
  type Immutable,
  isNumber,
  isObject,
  isRecord,
  isString,
} from "../../utils/src/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type {
  JSONObject,
  JSONSchema,
  JSONValue,
  SchemaContext,
} from "./builder/types.ts";
import { isAlias } from "./builder/types.ts";
import { deepEqual } from "./path-utils.ts";

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
  constructor() {
    this.partial = new Set<K>();
  }
  enter(k: K): boolean {
    if (this.partial.has(k)) {
      console.error("Cycle Detected!");
      return false;
    }
    this.partial.add(k);
    return true;
  }
  exit(k: K) {
    this.partial.delete(k);
  }
}

export type PointerCycleTracker = CycleTracker<
  Immutable<JSONValue>
>;

type JSONCellLink = { cell: { "/": string }; path: string[] };
export type CellTarget = { path: string[]; cellTarget: string | undefined };

export interface ObjectStorageManager<K, S, V> {
  addRead(doc: K, value: V, source: S): void;
  addWrite(doc: K, value: V, source: S): void;
  // get the key for the doc pointed to by the cell target
  getTarget(value: CellTarget): K;
  // load the object for the specified key
  load(doc: K): ValueEntry<S, V | undefined> | null;
}

export type ValueEntry<T, V> = {
  value: V;
  source: T;
};

export type ValueAtPath<K> = {
  doc: K;
  docRoot: Immutable<JSONValue> | undefined;
  path: string[];
  value: Immutable<JSONValue> | undefined;
};

// I've really got two different concepts here.
// A. How we traverse the object
//  1. For a schema query, we traverse the object, but avoid visiting branches that don't match our schema
//  2. For a normal traversal, we traverse the object, visiting all child nodes.
// B. How we interact with the objects
//  1. Loading objects from the DB (on the server)
//  2. Loading objects from our memory interface (on the client)

export abstract class BaseObjectManager<K, S, V>
  implements ObjectStorageManager<K, S, V> {
  constructor(
    protected readValues = new Map<string, ValueEntry<S, V>>(),
    protected writeValues = new Map<string, ValueEntry<S, V>>(),
    protected readDependentDocs = new Map<string, Set<S>>(),
    protected writeDependentDocs = new Map<string, Set<S>>(),
  ) {}

  addRead(doc: K, value: V, source: S) {
    const key = this.toKey(doc);
    const dependencies = this.readDependentDocs.get(key) ?? new Set<S>();
    dependencies.add(source);
    this.readDependentDocs.set(key, dependencies);
    this.readValues.set(key, { value: value, source: source });
  }

  addWrite(doc: K, value: V, source: S) {
    const key = this.toKey(doc);
    const dependencies = this.writeDependentDocs.get(key) ?? new Set<S>();
    dependencies.add(source);
    this.writeDependentDocs.set(key, dependencies);
    this.writeValues.set(key, { value: value, source: source });
  }
  abstract getTarget(value: CellTarget): K;
  abstract load(doc: K): ValueEntry<S, V | undefined> | null;
  // get a string version of a key
  abstract toKey(doc: K): string;
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
export abstract class BaseObjectTraverser<K, S> {
  constructor(
    protected manager: BaseObjectManager<
      K,
      S,
      Immutable<JSONValue> | undefined
    >,
  ) {}
  abstract traverse(doc: ValueAtPath<K>): Immutable<OptJSONValue>;

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
    doc: ValueAtPath<K>,
    tracker: PointerCycleTracker,
    schemaTracker?: MapSet<string, SchemaPathSelector>,
  ): Immutable<JSONValue> | undefined {
    if (isPrimitive(doc.value)) {
      return doc.value;
    } else if (Array.isArray(doc.value)) {
      if (tracker.enter(doc.value)) {
        try {
          return doc.value.map((item, index) =>
            this.traverseDAG(
              { ...doc, path: [...doc.path, index.toString()], value: item },
              tracker,
              schemaTracker,
            )
          ) as Immutable<JSONValue>[];
        } finally {
          tracker.exit(doc.value);
        }
      } else {
        return null;
      }
    } else if (isObject(doc.value)) {
      // First, see if we need special handling
      if (isPointer(doc.value)) {
        const [newDoc, _] = getAtPath(
          this.manager,
          doc,
          [],
          tracker,
          schemaTracker,
          DefaultSchemaSelector,
        );
        if (newDoc.value === undefined || newDoc.docRoot === undefined) {
          return null;
        }
        return this.traverseDAG(newDoc, tracker, schemaTracker);
      } else {
        if (tracker.enter(doc.value)) {
          try {
            return Object.fromEntries(
              Object.entries(doc.value).map((
                [k, value],
              ) => [
                k,
                this.traverseDAG(
                  {
                    ...doc,
                    path: [...doc.path, k],
                    value: value,
                  },
                  tracker,
                  schemaTracker,
                ),
              ]),
            ) as Immutable<JSONValue>;
          } finally {
            tracker.exit(doc.value);
          }
        } else {
          return null;
        }
      }
    } else {
      console.error("Encountered unexpected object: ", doc.value);
      return null;
    }
  }
}

/**
 * Traverses a data structure following a path and resolves any pointers.
 * If we load any additional documents, we will also let the helper know.
 *
 * @param manager - Storage manager for document access.
 * @param doc - ValueAtPath for the current document
 * @param path - Property/index path to follow
 * @param tracker - Prevents pointer cycles
 * @param schemaTracker: Tracks schema used for loaded docs
 * @param selector: The selector being used (its path is relative to doc's root)
 *
 * @returns a tuple containing a ValueAtPath object with the target doc,
 * docRoot, path, and value and also containing the updated selector that
 * applies to that target doc.
 */
export function getAtPath<K, S>(
  manager: BaseObjectManager<K, S, Immutable<JSONValue> | undefined>,
  doc: ValueAtPath<K>,
  path: readonly string[],
  tracker: PointerCycleTracker,
  schemaTracker?: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
): [ValueAtPath<K>, SchemaPathSelector | undefined] {
  // we may mutate curDoc's value and path, so copy the object and the path
  let curDoc = { ...doc, path: [...doc.path] };
  let remaining = [...path];
  while (isPointer(curDoc.value)) {
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
      curDoc.value = elementAt(curDoc.value, part);
      curDoc.path.push(part);
    } else if (
      isObject(curDoc.value) && part in (curDoc.value as Immutable<JSONObject>)
    ) {
      const cursorObj = curDoc.value as Immutable<JSONObject>;
      curDoc.value = cursorObj[part] as Immutable<JSONValue>;
      curDoc.path.push(part);
    } else {
      // we can only descend into pointers, objects, and arrays
      return [{ ...curDoc, path: [], value: undefined }, selector];
    }
    // If this next value is a pointer, use the pointer resolution code
    while (isPointer(curDoc.value)) {
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

/**
 * Resolves a pointer reference to its target value.
 *
 * @param manager - Object storage manager for document access
 * @param doc - ValueAtPath for the current document
 * @param path - Property/index path to follow
 * @param tracker - Prevents infinite pointer cycles
 * @param schemaTracker: Tracks schema to use for loaded docs
 * @param selector?: SchemaPathSelector used to query the target doc
 *
 * @returns a ValueAtPath object with the target doc, docRoot, path, and value.
 */
function followPointer<K, S>(
  manager: BaseObjectManager<K, S, Immutable<JSONValue> | undefined>,
  doc: ValueAtPath<K>,
  path: readonly string[],
  tracker: PointerCycleTracker,
  schemaTracker?: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
): [ValueAtPath<K>, SchemaPathSelector | undefined] {
  if (!tracker.enter(doc.value!)) {
    return [{ ...doc, path: [], value: undefined }, selector];
  }
  try {
    const cellTarget = getPointerInfo(doc.value as Immutable<JSONObject>);
    const target = (cellTarget.cellTarget !== undefined)
      ? manager.getTarget(cellTarget)
      : doc.doc;
    let [targetDoc, targetDocRoot] = [doc.doc, doc.docRoot];
    if (selector !== undefined) {
      // We'll need to re-root the selector for the target doc
      // Remove the portions of doc.path from selector.path, limiting schema if needed
      // Also insert the portions of cellTarget.path, so selector is relative to new target doc
      // We do this even if the target doc is the same doc, since we want the
      // selector path to match.
      selector = narrowSchema(doc.path, selector, cellTarget.path);
    }
    if (cellTarget.cellTarget !== undefined) {
      // We have a reference to a different cell, so track the dependency
      // and update our targetDoc and targetDocRoot
      const valueEntry = manager.load(target);
      if (valueEntry === null) {
        return [{ ...doc, path: [], value: undefined }, selector];
      }
      if (
        valueEntry !== null && valueEntry.value !== undefined &&
        valueEntry.source && valueEntry.value !== doc.docRoot
      ) {
        manager.addRead(doc.doc, valueEntry.value, valueEntry.source);
      }
      if (schemaTracker !== undefined && selector !== undefined) {
        schemaTracker.add(manager.toKey(target), selector);
      }
      // If the object we're pointing to is a retracted fact, just return undefined.
      // We can't do a better match, but we do want to include the result so we watch this doc
      if (valueEntry.value === undefined) {
        return [
          { doc: target, docRoot: undefined, path: [], value: undefined },
          selector,
        ];
      }
      // Otherwise, we can continue with the target.
      // an assertion fact.is will be an object with a value property, and
      // that's what our schema is relative to.
      targetDoc = target;
      targetDocRoot = (valueEntry.value as Immutable<JSONObject>)["value"];
    }
    // We've loaded the linked doc, so walk the path to get to the right part of that doc (or whatever doc that path leads to),
    // then the provided path from the arguments.
    return getAtPath(
      manager,
      {
        doc: targetDoc,
        docRoot: targetDocRoot,
        path: [],
        value: targetDocRoot,
      },
      [...cellTarget.path, ...path],
      tracker,
      schemaTracker,
      selector,
    );
  } finally {
    tracker.exit(doc.value!);
  }
}

// docPath is where we found the pointer and are doing this work
// Selector path and schema used to be relative to the top of the doc, but
// we want them relative to the new doc.
// targetPath is the path in the target doc that the pointer points to
function narrowSchema(
  docPath: string[],
  selector: SchemaPathSelector,
  targetPath: string[],
): SchemaPathSelector {
  let docPathIndex = 0;
  while (docPathIndex < docPath.length && docPathIndex < selector.path.length) {
    if (docPath[docPathIndex] !== selector.path[docPathIndex]) {
      console.warn("Mismatched paths", docPath, selector.path);
      return MinimalSchemaSelector;
    }
    docPathIndex++;
  }
  if (docPathIndex < docPath.length) {
    // we've reached the end of our selector path, but still have parts in our doc path, so narrow the schema
    // Some of the schema may have been applicable to other parts of the doc, but we only want to use the
    // portion that will apply to the next doc.
    const cfc = new ContextualFlowControl();
    const schema = cfc.schemaAtPath(
      selector.schemaContext!.schema,
      docPath.slice(docPathIndex),
    );
    return {
      path: [...targetPath],
      schemaContext: {
        schema: schema,
        rootSchema: selector.schemaContext!.rootSchema,
      },
    };
  } else {
    // We've reached the end of the doc path, but still have stuff in our selector path, so remove
    // the path parts we've already walked from the selector.
    return {
      path: [...targetPath, ...selector.path.slice(docPath.length)],
      schemaContext: selector.schemaContext,
    };
  }
}

/**
 * Extract the path and cellTarget from an Alias or JSONCellLink
 *
 * @param value - The JSON object that might contain pointer information
 * @returns A CellTarget object containing:
 *   - path: An array of string segments representing the path to the target
 *   - cellTarget: The target cell identifier as a string, or undefined if it refers to the current document
 */
export function getPointerInfo(value: Immutable<JSONObject>): CellTarget {
  if (isAlias(value)) {
    if (isObject(value.$alias.cell) && "/" in value.$alias.cell) {
      return {
        path: value.$alias.path.map((p) => p.toString()),
        cellTarget: value.$alias.cell["/"] as string,
      };
    }
    return {
      path: value.$alias.path.map((p) => p.toString()),
      cellTarget: undefined,
    };
  } else if (isJSONCellLink(value)) {
    //console.error("cell: ", obj.cell, "; path: ", obj.path);
    return { path: value.path, cellTarget: value.cell["/"] as string };
  }
  return { path: [], cellTarget: undefined };
}

export function isPointer(value: unknown): boolean {
  return (isAlias(value) || isJSONCellLink(value));
}

/**
 * Check if value is a cell link. Unlike the isCellLink version, this does not check for a marker symbol, since that won't exist in the JSON object.
 *
 * @param {unknown} value - The value to check.
 * @returns {boolean}
 */
function isJSONCellLink(value: unknown): value is JSONCellLink {
  return (isObject(value) && "cell" in value && isObject(value.cell) &&
    "/" in value.cell && "path" in value &&
    Array.isArray(value.path));
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

export class SchemaObjectTraverser<K, S> extends BaseObjectTraverser<K, S> {
  constructor(
    manager: BaseObjectManager<K, S, Immutable<JSONValue> | undefined>,
    private selector: SchemaPathSelector,
    private tracker: PointerCycleTracker = new CycleTracker<
      Immutable<JSONValue>
    >(),
    private schemaTracker: MapSet<string, SchemaPathSelector> = new MapSet<
      string,
      SchemaPathSelector
    >(),
  ) {
    super(manager);
  }

  override traverse(
    doc: ValueAtPath<K>,
  ): Immutable<OptJSONValue> {
    this.schemaTracker.add(this.manager.toKey(doc.doc), this.selector);
    return this.traverseWithSelector(doc, this.selector);
  }

  // Traverse the specified doc with the selector.
  // The selector should have been re-rooted if needed to be relative to the specified doc
  // The selector must have a valid (defined) schemaContext
  traverseWithSelector(
    doc: ValueAtPath<K>,
    selector: SchemaPathSelector,
  ): Immutable<OptJSONValue> {
    if (deepEqual(doc.path, selector.path)) {
      return this.traverseWithSchemaContext(doc, selector.schemaContext!);
    } else if (doc.path.length > selector.path.length) {
      throw new Error("Doc path should never exceed selector path");
    } else if (!deepEqual(doc.path, selector.path.slice(0, doc.path.length))) {
      // There's a mismatch in the initial part, so this will not match
      return undefined;
    } else { // doc path length < selector.path.length
      const [nextDoc, nextSelector] = getAtPath(
        this.manager,
        doc,
        selector.path.slice(doc.path.length),
        this.tracker,
        this.schemaTracker,
        selector,
      );
      if (nextDoc.value === undefined) {
        return undefined;
      }
      if (!deepEqual(nextDoc.path, nextSelector!.path)) {
        throw new Error("New doc path doesn't match selector path");
      }
      this.traverseWithSchemaContext(nextDoc, nextSelector!.schemaContext!);
    }
  }

  traverseWithSchemaContext(
    doc: ValueAtPath<K>,
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
      console.warn("Invalid schema is not an object", schemaContext.schema);
      return undefined;
    }
    if ("$ref" in schemaContext.schema) {
      // At some point, this should be extended to support more than just '#'
      if (schemaContext.schema["$ref"] != "#") {
        console.warn(
          "Unsupported $ref in schema: ",
          schemaContext.schema["$ref"],
        );
      }
      if (schemaContext.rootSchema === undefined) {
        console.warn(
          "Unsupported $ref without root schema: ",
          schemaContext.schema["$ref"],
        );
        return undefined;
      }
      schemaContext = {
        schema: schemaContext.rootSchema,
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
        if (this.tracker.enter(doc.value)) {
          try {
            this.traverseArrayWithSchema(doc, {
              schema: schemaObj,
              rootSchema: schemaContext.rootSchema,
            });
          } finally {
            this.tracker.exit(doc.value);
          }
        } else {
          return null;
        }
      }
      return undefined;
    } else if (isObject(doc.value)) {
      if (isPointer(doc.value)) {
        return this.traversePointerWithSchema(doc, {
          schema: schemaObj,
          rootSchema: schemaContext.rootSchema,
        });
        // TODO(@ubik2): it might be technically ok to follow the same pointer more than once, since we might have
        // a different schema the second time, which could prevent an infinite cycle, but for now, just reject these.
      } else if (this.isValidType(schemaObj, "object")) {
        if (this.tracker.enter(doc.value)) {
          try {
            this.traverseObjectWithSchema(doc, {
              schema: schemaObj,
              rootSchema: schemaContext.rootSchema,
            });
          } finally {
            this.tracker.exit(doc.value);
          }
        } else {
          return null;
        }
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
    doc: ValueAtPath<K>,
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
        path: [...doc.path, index.toString()],
        value: item,
      };
      const selector = {
        path: curDoc.path,
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
    doc: ValueAtPath<K>,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const filteredObj: Record<string, Immutable<OptJSONValue>> = {};
    const schema = schemaContext.schema as Immutable<JSONObject>;
    for (const [propKey, propValue] of Object.entries(doc.value!)) {
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
      const val = this.traverseWithSchemaContext({
        ...doc,
        path: [...doc.path, propKey],
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

  // This just has a schemaContext, since the doc.path would match the selector.path
  private traversePointerWithSchema(
    doc: ValueAtPath<K>,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const [newDoc, newSelector] = getAtPath(
      this.manager,
      doc,
      [],
      this.tracker,
      this.schemaTracker,
      { path: [...doc.path], schemaContext: schemaContext },
    );
    if (newDoc.value === undefined) {
      return null;
    }
    // The call to getAtPath above will track entry into the pointer,
    // but we may have a pointer cycle of docs, and we've finished resolving
    // the pointer now. To avoid descending into a cycle, track entry to the
    // doc we were called with (not the one we resolved, which may be a pointer).
    if (this.tracker.enter(doc.value!)) {
      try {
        return this.traverseWithSelector(newDoc, newSelector!);
      } finally {
        this.tracker.exit(doc.value!);
      }
    } else {
      return null;
    }
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
export function isSchemaSuperset(
  schemaA: JSONSchema | boolean,
  schemaB: JSONSchema | boolean,
) {
  return (ContextualFlowControl.isTrueSchema(schemaA)) ||
    deepEqual(schemaA, schemaB) || (schemaB === false);
}
