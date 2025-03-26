import { set } from "./changes.ts";
import type {
  Entity,
  FactSelection,
  JSONObject,
  JSONValue,
  MemorySpace,
  Pointer,
  PointerV0,
  SchemaContext,
  SchemaPathSelector,
  SchemaSubscription,
  Selection,
  The,
} from "./interface.ts";
import { isNumber, isObject, isString } from "./util.ts";
import { arrayEqual } from "../runner/src/utils.ts";
import { FactSelector, SelectAll, selectFacts } from "./space.ts";
import { Database } from "@db/sqlite";
export * from "./interface.ts";

// This is the same structure as in space.ts, but there's also a different
// Session interface in memory/interface, so the space version isn't exported.
interface Session<Space extends MemorySpace> {
  subject: Space;
  store: Database;
}

class CycleTracker<K, V> {
  private partial: Set<K>;
  private complete: Map<K, V>;

  constructor() {
    this.partial = new Set<K>();
    this.complete = new Map<K, V>();
  }

  enter(k: K): boolean {
    if (this.partial.has(k)) {
      return false;
    }
    this.partial.add(k);
    return true;
  }

  exit(k: K, v: V | undefined = undefined) {
    this.partial.delete(k);
    if (v !== undefined) {
      this.complete.set(k, v);
    }
  }

  has(k: K): boolean {
    return this.complete.has(k);
  }

  get(k: K): V | undefined {
    return this.complete.get(k);
  }
}

export const isPointer = (value: JSONValue): value is Pointer => {
  const source = value as Partial<Pointer>;
  return typeof source?.$alias?.cell?.["/"] === "string" ||
    typeof source?.cell?.["/"] === "string";
};

export const selectSchema = <Space extends MemorySpace>(
  session: Session<Space>,
  { selectSchema, since }: SchemaSubscription["args"],
): FactSelection => {
  const selection: FactSelection = {}; // we'll store our filtered result here
  const factSelection: FactSelection = {}; // we'll store our initial facts here
  // First, collect all the potentially relevant facts (without dereferencing pointers)
  for (const [ofKey, ofValues] of Object.entries(selectSchema)) {
    for (const [the, theValues] of Object.entries(ofValues)) {
      // We'll use an object for each [of,the] combination
      for (const [cause, selector] of Object.entries(theValues)) {
        const of = ofKey as (Entity | "_");
        loadFacts(factSelection, session, { the, of, cause, since });
      }
    }
  }
  // Then filter the facts by the associated schemas, which will dereference
  // pointers as we walk through the structure.
  for (const [of, ofValues] of Object.entries(factSelection)) {
    const schemaFilterOf = selectSchema[of as Entity] ??
      selectSchema[SelectAll];
    if (schemaFilterOf === undefined) {
      continue;
    }
    for (const [the, theValues] of Object.entries(ofValues)) {
      const schemaFilterThe = schemaFilterOf[the] ?? schemaFilterOf[SelectAll];
      if (schemaFilterThe === undefined) {
        continue;
      }
      for (const [cause, factEntry] of Object.entries(theValues)) {
        const selector = schemaFilterThe[cause] ?? schemaFilterThe[SelectAll];
        if (selector === undefined) {
          continue;
        }
        let result;
        if (isObject(factEntry.is)) {
          const factValue = (factEntry.is as JSONObject).value;
          result = checkFactMatch(
            session,
            factValue,
            [],
            selector,
            new CycleTracker<JSONValue, JSONValue | undefined>(),
          );
        }
        set(selection, [of, the], cause, {
          is: (result === undefined) ? {} : { value: result },
        });
      }
    }
  }

  return selection;
};

function getAtPath<Space extends MemorySpace>(
  session: Session<Space>,
  fact: JSONValue | undefined,
  path: string[],
  tracker: CycleTracker<JSONValue, JSONValue | undefined>,
) {
  let cursor = fact;
  //console.log("Called getAtPath", fact, path);
  for (const [index, part] of path.entries()) {
    if (cursor !== undefined && isPointer(cursor)) {
      const loadedObj = loadPointer(session, cursor, tracker);
      return getAtPath(session, loadedObj, path.slice(index), tracker);
    }
    if (isObject(cursor) && part in (cursor as JSONObject)) {
      const cursorObj = cursor as JSONObject;
      cursor = cursorObj[part] as JSONValue;
    } else if (Array.isArray(cursor)) {
      const numericKeyValue = new Number(part).valueOf();
      if (
        Number.isInteger(numericKeyValue) &&
        numericKeyValue >= 0 && numericKeyValue < cursor.length
      ) {
        cursor = cursor[numericKeyValue];
      } else {
        return undefined;
      }
    } else {
      // we can only descend into pointers, cursors and arrays
      return undefined;
    }
  }
  return cursor;
}

function loadPointer<Space extends MemorySpace>(
  session: Session<Space>,
  obj: JSONValue,
  tracker: CycleTracker<JSONValue, JSONValue | undefined>,
): JSONValue | undefined {
  if (tracker.has(obj)) {
    return tracker.get(obj);
  }
  //console.log("Cell Link: ", obj);
  if (!tracker.enter(obj)) {
    console.error("Cycle Detected!");
    // FIXME(@ubik2) Need to handle this
    return null;
  }
  const source = obj as Partial<Pointer>;
  let cellTarget: string | undefined;
  let path: string[];
  if (typeof source?.$alias?.cell?.["/"] === "string") {
    cellTarget = source.$alias.cell["/"];
    path = source.$alias.path.map((p) => p.toString());
  } else if (typeof source?.cell?.["/"] === "string") {
    cellTarget = source.cell["/"];
    path = (source as PointerV0).path.map((p) => p.toString());
  } else {
    console.error("Unable to load cell target");
    tracker.exit(obj);
    return undefined;
  }
  const selection = {};
  loadFacts(selection, session, {
    the: "application/json",
    of: `of:${cellTarget}`,
    cause: SelectAll,
  });
  const lastFact = getFirstFact(selection);
  const result = getAtPath(session, lastFact, path, tracker);
  tracker.exit(obj, result);
  return result;
}

function loadFacts<Space extends MemorySpace>(
  selection: Selection<Space>[Space],
  session: Session<Space>,
  factSelector: FactSelector,
): FactSelection {
  for (
    const fact of selectFacts(session, factSelector)
  ) {
    set(
      selection,
      [fact.of, fact.the],
      fact.cause,
      (fact.is !== undefined) ? { is: fact.is } : {},
    );
  }
  return selection;
}

// Gets the value of the last fact in the selection
function getFirstFact(
  selection: FactSelection,
): JSONValue | undefined {
  for (const [of, ofValue] of Object.entries(selection)) {
    for (const [the, theValue] of Object.entries(ofValue)) {
      for (const [cause, causeValue] of Object.entries(theValue)) {
        if (causeValue.is === undefined) {
          return undefined;
        } else if (isObject(causeValue.is)) {
          return (causeValue.is as JSONObject).value;
        }
      }
    }
  }
  return undefined;
}

// Recursively resolve the cells
function resolveCells<Space extends MemorySpace>(
  session: Session<Space>,
  factIs: JSONValue,
  tracker: CycleTracker<JSONValue, JSONValue | undefined>,
): JSONValue {
  if (
    factIs === undefined || factIs === null || isString(factIs) ||
    isNumber(factIs) || typeof factIs === "boolean"
  ) {
    return factIs;
  } else if (Array.isArray(factIs)) {
    return factIs.map((item) => resolveCells(session, item, tracker));
  } else if (isObject(factIs)) {
    // First, see if we need special handling
    if (isPointer(factIs)) {
      const resolvedFactIs = loadPointer(session, factIs, tracker);
      if (resolvedFactIs === undefined) {
        console.error("Got broken link");
        return null;
      }
      return resolveCells(session, resolvedFactIs, tracker);
    } else {
      // Regular object
      const resolvedObj: JSONObject = {};
      for (const [key, value] of Object.entries(factIs)) {
        resolvedObj[key] = resolveCells(session, value, tracker);
      }
      return resolvedObj;
    }
  } else {
    console.error("Encountered unexpected object: ", factIs);
    return null;
  }
}

// Check whether this fact has anything matching our query
// TODO(@ubik2) this would be better with a tree walking callback
// After this is complete, we may want to support cycles in our object
function checkFactMatch<Space extends MemorySpace>(
  session: Session<Space>,
  value: JSONValue | undefined,
  path: PropertyKey[],
  nodeSelector: SchemaPathSelector,
  tracker: CycleTracker<JSONValue, JSONValue | undefined>,
): JSONValue | undefined {
  if (value !== undefined && isPointer(value)) {
    value = loadPointer(session, value, tracker);
  }
  if (arrayEqual(nodeSelector.path, path)) {
    return (value === undefined) ? undefined : getSchemaIntersection(
      session,
      value,
      nodeSelector.schemaContext,
      tracker,
    );
  } else {
    // path.length should never be >= nodeSelector.path.length
    if (
      value === undefined || value === null || isString(value) ||
      isNumber(value) || typeof value === "boolean"
    ) {
      // If we have a basic fact at this level, we shouldn't include it
      return undefined;
    } else if (Array.isArray(value)) {
      const nextSelectorPath = nodeSelector.path[path.length];
      const numericKeyValue = new Number(nextSelectorPath).valueOf();
      if (
        Number.isInteger(numericKeyValue) &&
        numericKeyValue >= 0 && numericKeyValue < value.length
      ) {
        // Our node selector is filtering to grab a single item from the array
        const newPath = [...path];
        newPath.push(numericKeyValue.toString());
        // We can't return an array with undefined, and we don't want to move indices,
        // so we'll fill the other fields with null. If we have no match, we can just
        // skip returning this entirely.
        const rv = Array(value.length).fill(null);
        const subresult = checkFactMatch(
          session,
          value[numericKeyValue],
          newPath,
          nodeSelector,
          tracker,
        );
        if (subresult !== undefined) {
          rv[numericKeyValue] = subresult;
          return rv;
        }
      }
      return undefined;
    } else if (isObject(value)) {
      const valueObj = value as JSONObject;
      const nextSelectorPath: string = nodeSelector.path[path.length];
      const rv: Record<string, JSONValue> = {};
      if (nextSelectorPath in valueObj) {
        const newPath = [...path];
        newPath.push(nextSelectorPath);
        const subresult = checkFactMatch(
          session,
          valueObj[nextSelectorPath],
          newPath,
          nodeSelector,
          tracker,
        );
        if (subresult !== undefined) {
          rv[nextSelectorPath] = subresult;
          return rv;
        }
      }
      return undefined;
    }
  }
  return undefined;
}

// We have a query with a schema, so see what portion of our object matches
// We'll walk through the object while it matches our schema, handling pointers
// along the way.
function getSchemaIntersection<Space extends MemorySpace>(
  session: Session<Space>,
  object: JSONValue,
  { schema, rootSchema }: SchemaContext,
  tracker: CycleTracker<JSONValue, JSONValue | undefined>,
): JSONValue | undefined {
  if (schema == true || (isObject(schema) && Object.keys(schema).length == 0)) {
    // These values in a schema match any object - resolve the rest of the cells, and return
    return resolveCells(session, object, tracker);
  } else if (schema == false) {
    return undefined;
  }
  if (!isObject(schema)) {
    console.warn("Invalid schema is not an object", schema);
  }
  if ("$ref" in schema) {
    // At some point, this should be extended to support more than just '#'
    if (schema["$ref"] != "#") {
      console.warn("Unsupported $ref in schema: ", schema["$ref"]);
    }
    if (rootSchema === undefined) {
      console.warn("Unsupported $ref without root schema: ", schema["$ref"]);
      return undefined;
    }
    schema = rootSchema;
  }
  const schemaObj = schema as Record<string, any>;
  if (object === null) {
    return ("type" in schemaObj && schemaObj["type"] == "null")
      ? object
      : undefined;
  } else if (isString(object)) {
    return ("type" in schemaObj && schemaObj["type"] == "string")
      ? object
      : undefined;
  } else if (isNumber(object)) {
    return ("type" in schemaObj && schemaObj["type"] == "number")
      ? object
      : undefined;
  } else if (Array.isArray(object)) {
    if ("type" in schemaObj && schemaObj["type"] == "array") {
      const arrayObj = [];
      for (const item of object) {
        const val = getSchemaIntersection(session, item, {
          schema: schemaObj["items"],
          rootSchema,
        }, tracker);
        if (val === undefined) {
          // this array is invalid, since one or more items do not match the schema
          return undefined;
        }
        arrayObj.push(val);
      }
      return arrayObj;
    }
    return undefined;
  } else if (isObject(object)) {
    if (isPointer(object)) {
      const loaded = loadPointer(session, object, tracker);
      if (loaded !== undefined) {
        object = loaded;
      } else {
        // If we can't load the target, pretend it's an empty object
        console.error("Unable to load pointer");
        object = {} as JSONValue;
      }
      // Start over, since the object type may be different
      return getSchemaIntersection(
        session,
        object,
        { schema, rootSchema },
        tracker,
      );
    }
    const filteredObj: Record<string, JSONValue> = {};
    if ("type" in schemaObj && schemaObj["type"] == "object") {
      for (const [propKey, propValue] of Object.entries(object)) {
        if (isObject(schemaObj.properties) && propKey in schemaObj.properties) {
          const val = getSchemaIntersection(session, propValue, {
            schema: schemaObj.properties[propKey],
            rootSchema,
          }, tracker);
          if (val !== undefined) {
            filteredObj[propKey] = val;
          }
        } else if (isObject(schemaObj.additionalProperties)) {
          const val = getSchemaIntersection(session, propValue, {
            schema: schemaObj.additionalProperties,
            rootSchema,
          }, tracker);
          if (val !== undefined) {
            filteredObj[propKey] = val;
          }
        }
      }
      // Check that all required fields are present
      if ("required" in schemaObj) {
        const required = schemaObj["required"] as string[];
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
  }
}
