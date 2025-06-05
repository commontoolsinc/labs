// TODO(@ubik2): Ideally this would use the following, but rollup has issues
//import { isNumber, isObject, isString } from "@commontools/utils/types";
import {
  type Immutable,
  isNumber,
  isObject,
  isString,
} from "../../utils/src/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type {
  JSONObject,
  JSONSchema,
  JSONValue,
  SchemaContext,
} from "./types.ts";
import { isAlias } from "./types.ts";
import { deepEqual } from "./utils.ts";

// TODO: Fix redundant type definition, but we can't import memory here
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

// V must be a DAG, though it may have aliases or cell links that make it seem like it has cycles
export interface ObjectTraverser<K, V> {
  traverse(
    doc: K,
    docRoot: V,
    value: V,
  ): V;
}

export abstract class BaseObjectTraverser<K, S>
  implements ObjectTraverser<K, Immutable<OptJSONValue>> {
  constructor(
    protected manager: BaseObjectManager<
      K,
      S,
      Immutable<JSONValue> | undefined
    >,
  ) {}
  abstract traverse(
    doc: K,
    docRoot: Immutable<JSONValue>,
    value: Immutable<JSONValue>,
  ): Immutable<OptJSONValue>;

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
    docRoot: Immutable<JSONValue>,
    value: Immutable<JSONValue>,
    tracker: PointerCycleTracker,
    schemaTracker?: MapSet<string, SchemaPathSelector>,
  ): Immutable<JSONValue> {
    // FIXME: remove this
    console.log("doc root === value ? ", docRoot === value);

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
          this.manager,
          doc,
          docRoot,
          value,
          [],
          tracker,
          schemaTracker,
          DefaultSchemaSelector,
        );
        if (newObj === undefined) {
          return null;
        }
        return this.traverseDAG(
          newDoc,
          newDocRoot,
          newObj,
          tracker,
          schemaTracker,
        );
      } else {
        if (tracker.enter(value)) {
          try {
            return Object.fromEntries(
              Object.entries(value).map((
                [k, v],
              ): any => [
                k,
                this.traverseDAG(doc, docRoot, v, tracker),
              ]),
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

// export class BasicObjectTraverser<K, S> extends BaseObjectTraverser<K, S> {
//   //   constructor(helper: ObjectStorageManager<T, JSONValue>) {
//   //     super(helper);
//   //   }

//   override traverse(
//     doc: K,
//     docRoot: Immutable<JSONValue>,
//     value: Immutable<JSONValue>,
//   ): Immutable<JSONValue> | undefined {
//     const tracker = new CycleTracker<Immutable<JSONValue>>();
//     return this.traverseDAG(
//       doc,
//       docRoot,
//       value,
//       tracker,
//     );
//   }
// }

/**
 * Traverses a data structure following a path and resolves any pointers.
 * If we load any additional documents, we will also let the helper know.
 *
 * @param manager - Storage manager for document access.
 * @param doc - Current document address
 * @param docRoot - Current document's root as JSON
 * @param fact - Starting value for traversal
 * @param path - Property/index path to follow
 * @param tracker - Prevents pointer cycles
 * @param schemaTracker: Tracks schema used for loaded docs
 *
 * @returns [finalDoc, finalDocRoot, valueAtPath] - Final document, its root, and the value at path (or undefined)
 */
export function getAtPath<K, S>(
  manager: BaseObjectManager<K, S, Immutable<JSONValue> | undefined>,
  doc: K,
  docRoot: Immutable<JSONValue>,
  fact: Immutable<JSONValue> | undefined,
  path: readonly string[],
  tracker: PointerCycleTracker,
  schemaTracker?: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
): [K, Immutable<JSONValue>, Immutable<JSONValue> | undefined] {
  if (isPointer(fact)) {
    [doc, docRoot, fact] = followPointer(
      manager,
      doc,
      docRoot,
      fact as Immutable<JSONObject>,
      tracker,
      schemaTracker,
      selector,
    );
  }
  let cursor = fact;
  for (const [_index, part] of path.entries()) {
    // TODO(@ubik2) Call toJSON on object if it's a function?
    if (isPointer(cursor)) {
      [doc, docRoot, cursor] = followPointer(
        manager,
        doc,
        docRoot,
        cursor as Immutable<JSONObject>,
        tracker,
        schemaTracker,
        selector,
      );
    } else if (isObject(cursor) && part in (cursor as Immutable<JSONObject>)) {
      const cursorObj = cursor as Immutable<JSONObject>;
      cursor = cursorObj[part] as Immutable<JSONValue>;
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
 * @param manager - Object storage manager for document access
 * @param doc - Current document
 * @param docRoot - Current document's root as JSON
 * @param fact - Pointer object to resolve
 * @param tracker - Prevents infinite pointer cycles
 * @param schemaTracker: Tracks schema to use for loaded docs
 *
 * @returns [targetDoc, targetDocRoot, resolvedValue] - Target document, its root, and the resolved value (or undefined)
 */
function followPointer<K, S>(
  manager: BaseObjectManager<K, S, Immutable<JSONValue> | undefined>,
  doc: K,
  docRoot: Immutable<JSONValue>,
  fact: Immutable<JSONObject>,
  tracker: PointerCycleTracker,
  schemaTracker?: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
): [K, Immutable<JSONValue>, Immutable<JSONValue> | undefined] {
  if (!tracker.enter(fact)) {
    console.error("Cycle Detected!");
    return [doc, docRoot, undefined];
  }
  try {
    const cellTarget = getPointerInfo(fact as Immutable<JSONObject>);
    const target = (cellTarget.cellTarget !== undefined)
      ? manager.getTarget(cellTarget)
      : doc;
    let [targetDoc, targetDocRoot] = [doc, docRoot];
    if (cellTarget.cellTarget !== undefined) {
      // We have a reference to a different cell, so track the dependency
      // and update our targetDoc and targetDocRoot
      const valueEntry = manager.load(target);
      if (valueEntry === null) {
        return [doc, docRoot, undefined];
      }
      if (
        valueEntry !== null && valueEntry.value !== undefined &&
        valueEntry.source && valueEntry.value !== docRoot
      ) {
        schemaTracker?.add(manager.toKey(doc), selector!);
        manager.addRead(doc, valueEntry.value, valueEntry.source);
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
        (valueEntry.value as Immutable<JSONObject>)["value"],
      ];
    }
    // We've loaded the linked doc, so walk the path to get to the right part of that doc (or whatever doc that path leads to),
    const [nextDoc, nextDocRoot, nextObj] = getAtPath(
      manager,
      targetDoc,
      targetDocRoot,
      targetDocRoot,
      cellTarget.path,
      tracker,
      schemaTracker,
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
 * @param {any} value - The value to check.
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
    private schemaContext: SchemaContext,
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
    doc: K,
    docRoot: Immutable<JSONValue>,
    value: Immutable<JSONValue>,
  ): Immutable<OptJSONValue> {
    this.schemaTracker.add(this.manager.toKey(doc), {
      path: [],
      schemaContext: this.schemaContext,
    });
    return this.traverseWithSchema(
      doc,
      docRoot,
      value,
      this.schemaContext,
    );
  }

  traverseWithSchema(
    doc: K,
    docRoot: Immutable<JSONValue>,
    value: Immutable<JSONValue>,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    if (ContextualFlowControl.isTrueSchema(schemaContext.schema)) {
      // A value of true or {} means we match anything
      // Resolve the rest of the doc, and return
      return this.traverseDAG(doc, docRoot, value, this.tracker);
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
    if (value === null) {
      return ("type" in schemaObj && schemaObj["type"] === "null")
        ? value
        : undefined;
    } else if (isString(value)) {
      return ("type" in schemaObj && schemaObj["type"] === "string")
        ? value
        : undefined;
    } else if (isNumber(value)) {
      return ("type" in schemaObj && schemaObj["type"] === "number")
        ? value
        : undefined;
    } else if (Array.isArray(value)) {
      if ("type" in schemaObj && schemaObj["type"] === "array") {
        if (this.tracker.enter(value)) {
          try {
            this.traverseArrayWithSchema(doc, docRoot, value, {
              schema: schemaObj,
              rootSchema: schemaContext.rootSchema,
            });
          } finally {
            this.tracker.exit(value);
          }
        } else {
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
          { schema: schemaObj, rootSchema: schemaContext.rootSchema },
        );
        // TODO(@ubik2): it might be technically ok to follow the same pointer more than once, since we might have
        // a different schema the second time, which could prevent an infinite cycle, but for now, just reject these.
      } else if ("type" in schemaObj && schemaObj["type"] === "object") {
        if (this.tracker.enter(value)) {
          try {
            this.traverseObjectWithSchema(
              doc,
              docRoot,
              value as Immutable<JSONObject>,
              { schema: schemaObj, rootSchema: schemaContext.rootSchema },
            );
          } finally {
            this.tracker.exit(value);
          }
        } else {
          return null;
        }
      }
    }
  }

  private traverseArrayWithSchema(
    doc: K,
    docRoot: Immutable<JSONValue>,
    value: readonly Immutable<JSONValue>[],
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const arrayObj = [];
    const schema = schemaContext.schema as Immutable<JSONObject>;
    for (const item of value) {
      const itemSchema = isObject(schema["items"])
        ? schema["items"] as JSONSchema
        : typeof (schema["items"]) === "boolean"
        ? schema["items"]
        : true;
      const val = this.traverseWithSchema(doc, docRoot, item, {
        schema: itemSchema,
        rootSchema: schemaContext.rootSchema,
      });
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
    docRoot: Immutable<JSONValue>,
    value: Immutable<JSONObject>,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const filteredObj: Record<string, Immutable<OptJSONValue>> = {};
    const schema = schemaContext.schema as Immutable<JSONObject>;
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
      const val = this.traverseWithSchema(doc, docRoot, propValue, {
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

  private traversePointerWithSchema(
    doc: K,
    docRoot: Immutable<JSONValue>,
    value: Immutable<JSONObject>,
    schemaContext: SchemaContext,
  ): Immutable<OptJSONValue> {
    const [newDoc, newDocRoot, newObj] = getAtPath(
      this.manager,
      doc,
      docRoot,
      value,
      [],
      this.tracker,
      this.schemaTracker,
    );
    if (newObj === undefined) {
      return null;
    }
    if (this.tracker.enter(value)) {
      try {
        this.schemaTracker.add(this.manager.toKey(newDoc), {
          path: [],
          schemaContext: schemaContext,
        });
        return this.traverseWithSchema(
          newDoc,
          newDocRoot,
          newObj,
          schemaContext,
        );
      } finally {
        this.tracker.exit(value);
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
