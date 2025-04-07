import { set } from "./changes.ts";
import type {
  Entity,
  FactSelection,
  JSONObject,
  JSONValue,
  MemorySpace,
  SchemaContext,
  SchemaPathSelector,
  SchemaQuery,
} from "./interface.ts";
import { isNumber, isObject, isString } from "./util.ts";
import { arrayEqual } from "../runner/src/utils.ts";
import { FactSelector, SelectAll, selectFacts, Session } from "./space.ts";
import { Alias, isAlias } from "../builder/src/types.ts";
export * from "./interface.ts";

// This is the same structure as in space.ts, but there's also a different
// Session interface in memory/interface, so the space version isn't exported.

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

  exit(k: K) {
    this.partial.delete(k);
  }

  set(k: K, v: V) {
    return this.complete.set(k, v);
  }

  has(k: K): boolean {
    return this.complete.has(k);
  }

  get(k: K): V | undefined {
    return this.complete.get(k);
  }
}

type PointerCycleTracker = CycleTracker<
  JSONValue,
  [JSONValue, JSONValue | undefined]
>;

type JSONCellLink = { cell: { "/": string }; path: string[] };

/**
 * Check if value is a cell link. Unlike the isCellLink version, this does not check for a marker symbol, since that won't exist in the JSON object.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
function isJSONCellLink(value: any): value is JSONCellLink {
  return (
    typeof value === "object" && value !== null && isObject(value.cell) &&
    "/" in value.cell &&
    Array.isArray(value.path)
  );
}

export const selectSchema = <Space extends MemorySpace>(
  session: Session<Space>,
  { selectSchema, since }: SchemaQuery["args"],
): FactSelection => {
  const factSelection: FactSelection = {}; // we'll store our initial facts here
  const includedFacts: FactSelection = {}; // we'll store all the raw facts we accesed here
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
  // All the top level facts we accessed should be included
  mergeSelection(includedFacts, factSelection);
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
            includedFacts,
            factValue,
            factValue,
            [],
            selector,
            new CycleTracker<JSONValue, [JSONValue, JSONValue | undefined]>(),
          );
        }
        // copy our expanded object into the top level of our result
        const resultEntry = (result !== undefined)
          ? { is: { value: result }, since: factEntry.since }
          : { since: factEntry.since };
        set(includedFacts, ["_", the], cause, resultEntry);
      }
    }
  }
  for (const [ofKey, ofValues] of Object.entries(selectSchema)) {
    for (const [the, theValues] of Object.entries(ofValues)) {
      // We'll use an object for each [of,the] combination
      for (const [cause, selector] of Object.entries(theValues)) {
        const of = ofKey as (Entity | "_");
        loadFacts(factSelection, session, { the, of, cause, since });
      }
    }
  }

  // Any entities referenced in our selectSchema must be returned in the response
  // I'm not sure this is the best behavior, but it matches the schema-free query code.
  // Our returned stub objects will not have a cause.
  for (const [ofKey, ofValues] of Object.entries(selectSchema)) {
    if (ofKey === "_") { // we don't need to return a stub for wildcard `of`
      continue;
    }
    const ofFacts = includedFacts[ofKey as Entity] ?? {};
    for (const [the, _value] of Object.entries(ofValues)) {
      if (the in ofFacts) { // we already have a `the` fact for this entity
        continue;
      } else {
        ofFacts[the] = {};
      }
    }
    includedFacts[ofKey as Entity] = ofFacts;
  }
  return includedFacts;
};

// Walk down the fact object along the path, loading/following any pointers we encounter along the way
function getAtPath<Space extends MemorySpace>(
  session: Session<Space>,
  includedFacts: FactSelection,
  currentDoc: JSONValue,
  fact: JSONValue | undefined,
  path: string[],
  tracker: PointerCycleTracker,
): JSONValue | undefined {
  let cursor = fact;
  for (const [index, part] of path.entries()) {
    if (isAlias(cursor) || isJSONCellLink(cursor)) {
      const [loadedDoc, loadedObj] = loadPointer(
        session,
        includedFacts,
        currentDoc,
        cursor,
        tracker,
      );
      return getAtPath(
        session,
        includedFacts,
        loadedDoc,
        loadedObj,
        path.slice(index),
        tracker,
      );
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

// Load the pointer at the specified path
// We will return both the full doc, and the path slice
// Either of these documents may still contain pointers
// The pointer may be local, in which case we don't actually load
function loadPointer<Space extends MemorySpace>(
  session: Session<Space>,
  includedFacts: FactSelection,
  currentDoc: JSONValue,
  obj: JSONValue,
  tracker: CycleTracker<
    JSONValue,
    [JSONValue, JSONValue | undefined]
  >,
): [JSONValue, JSONValue | undefined] {
  if (tracker.has(obj)) {
    return tracker.get(obj)!;
  }
  //console.log("Cell Link: ", obj);
  if (!tracker.enter(obj)) {
    console.error("Cycle Detected!");
    // FIXME(@ubik2) Need to handle this
    return [currentDoc, null];
  }
  let cellTarget: string | undefined;
  let path: string[];
  if (isAlias(obj)) {
    path = obj.$alias.path.map((p) => p.toString());
    if (obj.$alias.cell === undefined) {
      // This is a local alias to part of our currentDoc,
      // but it may need to load other pointers to get there
      const localResult = getAtPath(
        session,
        includedFacts,
        currentDoc,
        currentDoc,
        path,
        tracker,
      );
      tracker.set(obj, [currentDoc, localResult]);
      tracker.exit(obj);
      return [currentDoc, localResult];
    }
    cellTarget = obj.$alias.cell["/"];
  } else if (isJSONCellLink(obj)) {
    //console.error("cell: ", obj.cell, "; path: ", obj.path);
    path = obj.path;
    cellTarget = obj.cell["/"];
  } else {
    console.error("Unable to load cell target", obj);
    tracker.exit(obj);
    return [currentDoc, undefined];
  }
  const selection = {};
  loadFacts(selection, session, {
    the: "application/json",
    of: `of:${cellTarget}`,
    cause: SelectAll,
  });
  const fact = getFact(selection);
  if (fact === undefined) {
    tracker.set(obj, [currentDoc, undefined]);
    tracker.exit(obj);
    return [currentDoc, undefined];
  } else {
    mergeSelection(includedFacts, selection);
    // TODO(@ubik2) at some later point, I could exclude any entries we didn't use
    const result = getAtPath(session, includedFacts, fact, fact, path, tracker);
    tracker.set(obj, [fact, result]);
    tracker.exit(obj);
    return [fact, result];
  }
}

// Merge the updates into the existing fact selection
function mergeSelection(existing: FactSelection, updates: FactSelection) {
  for (const [of, ofValue] of Object.entries(updates)) {
    for (const [the, theValue] of Object.entries(ofValue)) {
      for (const [cause, causeValue] of Object.entries(theValue)) {
        set(existing, [of, the], cause, causeValue);
      }
    }
  }
}

function loadFacts<Space extends MemorySpace>(
  selection: FactSelection,
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
      (fact.is !== undefined)
        ? { is: fact.is, since: fact.since }
        : { since: fact.since },
    );
  }
  return selection;
}

// Gets the value of the first fact in the selection
// TODO(@ubik2) should this be the last fact?
function getFact(
  selection: FactSelection,
): JSONValue | undefined {
  for (const [of, ofValue] of Object.entries(selection)) {
    for (const [the, theValue] of Object.entries(ofValue)) {
      if (isObject(theValue) && Object.entries(theValue).length > 1) {
        console.warn("Got more than one fact");
      }
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

function isUnavailableLink(obj: JSONCellLink | Alias) {
  const path = isAlias(obj)
    ? obj.$alias.path
    : isJSONCellLink(obj)
    ? obj.path
    : undefined;
  if (Array.isArray(path) && path.length > 0) {
    const firstPath = path[0];
    if (firstPath === "argument" || firstPath === "internal") {
      return true;
    }
  }
  return false;
}

// Recursively resolve the cells. At this point, we know we want the whole thing.
function resolveCells<Space extends MemorySpace>(
  session: Session<Space>,
  includedFacts: FactSelection,
  currentDoc: JSONValue,
  factIs: JSONValue,
  tracker: CycleTracker<
    JSONValue,
    [JSONValue, JSONValue | undefined]
  >,
): JSONValue {
  if (
    factIs === undefined || factIs === null || isString(factIs) ||
    isNumber(factIs) || typeof factIs === "boolean"
  ) {
    return factIs;
  } else if (Array.isArray(factIs)) {
    return factIs.map((item) =>
      resolveCells(session, includedFacts, currentDoc, item, tracker)
    );
  } else if (isObject(factIs)) {
    // First, see if we need special handling
    if (isAlias(factIs) || isJSONCellLink(factIs)) {
      // TODO(@ubik2) we may not use this fact, so perhaps we shouldn't include
      // For now, I'm going to include and we can make improvements later
      const [loadedDoc, loadedObj] = loadPointer(
        session,
        includedFacts,
        currentDoc,
        factIs,
        tracker,
      );
      if (loadedObj === undefined) {
        // If it's a broken link to something other than argument or internal
        // (which are only available on the client), complain
        if (!isUnavailableLink(factIs)) {
          console.error("Got broken link loading ", factIs, " in ", currentDoc);
        }
        return null;
      }
      return resolveCells(
        session,
        includedFacts,
        loadedDoc,
        loadedObj,
        tracker,
      );
    } else {
      // Regular object
      const resolvedObj: JSONObject = {};
      for (const [key, value] of Object.entries(factIs)) {
        resolvedObj[key] = resolveCells(
          session,
          includedFacts,
          currentDoc,
          value,
          tracker,
        );
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
  includedFacts: FactSelection,
  currentDoc: JSONValue,
  value: JSONValue | undefined,
  path: PropertyKey[],
  nodeSelector: SchemaPathSelector,
  tracker: PointerCycleTracker,
): JSONValue | undefined {
  if (isAlias(value) || isJSONCellLink(value)) {
    [currentDoc, value] = loadPointer(
      session,
      includedFacts,
      currentDoc,
      value,
      tracker,
    );
  }
  if (arrayEqual(nodeSelector.path, path)) {
    return (value === undefined) ? undefined : getSchemaIntersection(
      session,
      includedFacts,
      currentDoc,
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
          includedFacts,
          currentDoc,
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
          includedFacts,
          currentDoc,
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
// TODO(@ubik2) - need to add support for asCell and default; later add support for anyOf
function getSchemaIntersection<Space extends MemorySpace>(
  session: Session<Space>,
  includedFacts: FactSelection,
  currentDoc: JSONValue,
  object: JSONValue,
  { schema, rootSchema }: SchemaContext,
  tracker: PointerCycleTracker,
): JSONValue | undefined {
  if (
    schema === true || (isObject(schema) && Object.keys(schema).length == 0)
  ) {
    // These values in a schema match any object - resolve the rest of the cells, and return
    return resolveCells(session, includedFacts, currentDoc, object, tracker);
  } else if (schema === false) {
    // This value rejects all objects - just return
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
        const val = getSchemaIntersection(
          session,
          includedFacts,
          currentDoc,
          item,
          {
            schema: schemaObj["items"],
            rootSchema,
          },
          tracker,
        );
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
    if (isAlias(object) || isJSONCellLink(object)) {
      const [loadedDoc, loadedObj] = loadPointer(
        session,
        includedFacts,
        currentDoc,
        object,
        tracker,
      );
      if (loadedObj !== undefined) {
        object = loadedObj;
      } else {
        // If we can't load the target, pretend it's an empty object
        console.error("Unable to load pointer");
        object = {} as JSONValue;
      }
      // Start over, since the object type may be different
      return getSchemaIntersection(
        session,
        includedFacts,
        loadedDoc,
        object,
        { schema, rootSchema },
        tracker,
      );
    }
    const filteredObj: Record<string, JSONValue> = {};
    if ("type" in schemaObj && schemaObj["type"] == "object") {
      for (const [propKey, propValue] of Object.entries(object)) {
        if (isObject(schemaObj.properties) && propKey in schemaObj.properties) {
          const val = getSchemaIntersection(
            session,
            includedFacts,
            currentDoc,
            propValue,
            {
              schema: schemaObj.properties[propKey],
              rootSchema,
            },
            tracker,
          );
          if (val !== undefined) {
            filteredObj[propKey] = val;
          }
        } else if (
          isObject(schemaObj.additionalProperties) ||
          schemaObj.additionalProperties === true
        ) {
          const val = getSchemaIntersection(
            session,
            includedFacts,
            currentDoc,
            propValue,
            {
              schema: schemaObj.additionalProperties,
              rootSchema,
            },
            tracker,
          );
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
