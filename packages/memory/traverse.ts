// This is the same structure as in space.ts, but there's also a different
// Session interface in memory/interface, so the space version isn't exported.

import { isAlias, JSONObject, JSONValue } from "@commontools/builder";
import { isObject } from "@commontools/utils/types";

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
// TODO(@ubik2): I could restore tracking the completed objects here
export type PointerCycleTracker = CycleTracker<
  JSONValue
>;

type JSONCellLink = { cell: { "/": string }; path: string[] };
export type CellTarget = { path: string[]; cellTarget: string | undefined };

export interface ObjectStorageManager<K, S, V> {
  addRead(doc: K, value: V, source: S): void;
  addWrite(doc: K, value: V, source: S): void;
  getTarget(value: CellTarget): K;
  load(doc: K): ValueEntry<S, V | undefined> | null;
}

export type ValueEntry<T, V> = {
  value: V;
  source?: T;
};

// export type LooseJSONValue =
//   | JSONValue
//   | undefined
//   | ArrayLike<JSONValue | undefined>
//   | Record<string, JSONValue | undefined>;

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
    protected readValues = new Map<K, ValueEntry<S, V>>(),
    protected writeValues = new Map<K, ValueEntry<S, V>>(),
    protected readDependentDocs = new Map<K, Set<S>>(),
    protected writeDependentDocs = new Map<K, Set<S>>(),
  ) {}

  addRead(doc: K, value: V, source: S) {
    const dependencies = this.readDependentDocs.get(doc) ?? new Set<S>();
    dependencies.add(source);
    this.readDependentDocs.set(doc, dependencies);
    this.readValues.set(doc, { value: value, source: source });
  }

  addWrite(doc: K, value: V, source: S) {
    const dependencies = this.writeDependentDocs.get(doc) ?? new Set<S>();
    dependencies.add(source);
    this.writeDependentDocs.set(doc, dependencies);
    this.writeValues.set(doc, { value: value, source: source });
  }
  abstract getTarget(value: CellTarget): K;
  abstract load(doc: K): ValueEntry<S, V | undefined> | null;
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

// V must be a DAG, though it may have aliases or cell links that make it seem like it has cycles
export interface ObjectTraverser<K, V> {
  traverse(
    doc: K,
    docRoot: V,
    value: V,
  ): V | undefined;
}

export abstract class BaseObjectTraverser<K, S>
  implements ObjectTraverser<K, OptJSONValue> {
  constructor(
    protected helper: ObjectStorageManager<K, S, JSONValue>,
  ) {}
  abstract traverse(
    doc: K,
    docRoot: JSONValue,
    value: JSONValue,
  ): OptJSONValue;

  /**
   * Attempt to traverse the document as a directed acyclic graph.
   * This is the simplest form of traversal, where we include everything.
   *
   * @param doc
   * @param docRoot
   * @param value
   * @param helper
   * @param tracker
   * @returns
   */
  protected traverseDAG(
    doc: K,
    docRoot: JSONValue,
    value: JSONValue,
    tracker: PointerCycleTracker,
  ): JSONValue | undefined {
    if (isPrimitive(value)) {
      return value;
    } else if (Array.isArray(value)) {
      if (tracker.enter(value)) {
        try {
          return value.map((item) =>
            this.traverseDAG(doc, docRoot, item, tracker)
          ) as JSONValue[];
        } finally {
          tracker.exit(value);
        }
      } else {
        return null;
      }
    } else if (isObject(value)) {
      // First, see if we need special handling
      if (isPointer(value)) {
        const [newDoc, newDocRoot, newObj] = getAtPath(
          this.helper,
          doc,
          docRoot,
          value,
          [],
          tracker,
        );
        if (newObj === undefined) {
          return null;
        }
        return this.traverseDAG(newDoc, newDocRoot, newObj, tracker);
      } else {
        if (tracker.enter(value)) {
          try {
            return Object.fromEntries(
              Object.entries(value).map((
                [k, v],
              ): any => [k, this.traverseDAG(doc, docRoot, v, tracker)]),
            );
          } finally {
            tracker.exit(value);
          }
        } else {
          return null;
        }
      }
    } else {
      console.error("Encountered unexpected object: ", value);
      return null;
    }
  }
}

export class BasicObjectTraverser<K, S> extends BaseObjectTraverser<K, S> {
  //   constructor(helper: ObjectStorageManager<T, JSONValue>) {
  //     super(helper);
  //   }

  traverse(
    doc: K,
    docRoot: JSONValue,
    value: JSONValue,
  ): JSONValue | undefined {
    const tracker = new CycleTracker<JSONValue>();
    return this.traverseDAG(
      doc,
      docRoot,
      value,
      tracker,
    );
  }
}

/**
 * Traverses a data structure following a path and resolves any pointers.
 * If we load any additional documents, we will also let the traverser know.
 *
 * @param traverser - Storage manager for document access.
 * @param doc - Current document address
 * @param docRoot - Current document's root as JSON
 * @param fact - Starting value for traversal
 * @param path - Property/index path to follow
 * @param tracker - Prevents pointer cycles
 *
 * @returns [finalDoc, finalDocRoot, valueAtPath] - Final document, its root, and the value at path (or undefined)
 */
export function getAtPath<K, S>(
  traverser: ObjectStorageManager<K, S, JSONValue>,
  doc: K,
  docRoot: JSONValue,
  fact: JSONValue | undefined,
  path: string[],
  tracker: PointerCycleTracker,
): [K, JSONValue, JSONValue | undefined] {
  if (isPointer(fact)) {
    [doc, docRoot, fact] = followPointer(
      traverser,
      doc,
      docRoot,
      fact as JSONObject,
      tracker,
    );
  }
  let cursor = fact;
  for (const [index, part] of path.entries()) {
    // TODO(@ubik2) Call toJSON on object if it's a function?
    if (isPointer(cursor)) {
      [doc, docRoot, cursor] = followPointer(
        traverser,
        doc,
        docRoot,
        cursor as JSONObject,
        tracker,
      );
    } else if (isObject(cursor) && part in (cursor as JSONObject)) {
      const cursorObj = cursor as JSONObject;
      cursor = cursorObj[part] as JSONValue;
    } else if (Array.isArray(cursor)) {
      cursor = elementAt(cursor, part);
    } else {
      // we can only descend into pointers, objects, and arrays
      return [doc, docRoot, undefined];
    }
  }
  return [doc, docRoot, cursor];
}

/**
 * Resolves a pointer reference to its target value.
 *
 * @param traverser - Object storage manager for document access
 * @param doc - Current document
 * @param docRoot - Current document's root as JSON
 * @param fact - Pointer object to resolve
 * @param tracker - Prevents infinite pointer cycles
 *
 * @returns [targetDoc, targetDocRoot, resolvedValue] - Target document, its root, and the resolved value (or undefined)
 */
function followPointer<K, S>(
  traverser: ObjectStorageManager<K, S, JSONValue>,
  doc: K,
  docRoot: JSONValue,
  fact: JSONObject,
  tracker: PointerCycleTracker,
): [K, JSONValue, JSONValue | undefined] {
  if (!tracker.enter(fact)) {
    console.error("Cycle Detected!");
    return [doc, docRoot, undefined];
  }
  try {
    const cellTarget = getPointerInfo(fact as JSONObject);
    const target = (cellTarget.cellTarget !== undefined)
      ? traverser.getTarget(cellTarget)
      : doc;
    let [targetDoc, targetDocRoot] = [doc, docRoot];
    if (cellTarget.cellTarget !== undefined) {
      // We have a reference to a different cell, so track the dependency
      // and update our targetDoc and targetDocRoot
      const valueEntry = traverser.load(target);
      if (valueEntry === null) {
        return [doc, docRoot, undefined];
      }
      if (
        valueEntry !== null && valueEntry.value !== undefined &&
        valueEntry.source && valueEntry.value !== docRoot
      ) {
        traverser.addRead(doc, valueEntry.value, valueEntry.source);
      }
      // If the object we're pointing to is a retracted fact, just return undefined.
      // We can't do a better match, but we do want to include the result so we watch this doc
      if (valueEntry.value === undefined) {
        return [target, {}, undefined];
      }
      // Otherwise, we can continue with the target.
      // an assertion fact.is will be an object with a value property, and
      // that's what our schema is relative to.
      [targetDoc, targetDocRoot] = [
        target,
        (valueEntry.value as JSONObject)["value"],
      ];
    }
    // We've loaded the linked doc, so walk the path to get to the right part of that doc (or whatever doc that path leads to),
    const [nextDoc, nextDocRoot, nextObj] = getAtPath(
      traverser,
      targetDoc,
      targetDocRoot,
      targetDocRoot,
      cellTarget.path,
      tracker,
    );
    return [nextDoc, nextDocRoot, nextObj];
  } finally {
    tracker.exit(fact);
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
export function getPointerInfo(value: JSONObject): CellTarget {
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

export function isPointer(value: any): boolean {
  return (isAlias(value) || isJSONCellLink(value));
}

/**
 * Check if value is a cell link. Unlike the isCellLink version, this does not check for a marker symbol, since that won't exist in the JSON object.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
function isJSONCellLink(value: any): value is JSONCellLink {
  return (isObject(value) && "cell" in value && isObject(value.cell) &&
    "/" in value.cell && "path" in value &&
    Array.isArray(value.path));
}

export function indexFromPath(array: unknown[], path: string): any {
  const number = new Number(path).valueOf();
  return (Number.isInteger(number) && number >= 0 && number < array.length)
    ? number
    : undefined;
}

export function elementAt(array: unknown[], path: string): any {
  const index = indexFromPath(array, path);
  return (index === undefined) ? undefined : array[index];
}

type Primitive = string | number | boolean | null | undefined | symbol | bigint;

export function isPrimitive(val: unknown): val is Primitive {
  const type = typeof val;
  return val === null || (type !== "object" && type !== "function");
}
