import {
  deepEqual,
  ID,
  ID_FIELD,
  isAlias,
  isOpaqueRef,
  isStatic,
  type JSONSchema,
  markAsStatic,
  type Recipe,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  UnsafeBinding,
} from "@commontools/builder";
import { type DocImpl, getDoc, isDoc } from "./doc.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { type CellLink, isCell, isCellLink } from "./cell.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { createRef, getDocByEntityId } from "./doc-map.ts";
import { ContextualFlowControl } from "./index.ts";

/**
 * Extracts default values from a JSON schema object.
 * @param schema - The JSON schema to extract defaults from
 * @returns An object containing the default values, or undefined if none found
 */
export function extractDefaultValues(schema: any): any {
  if (typeof schema !== "object" || schema === null) return undefined;

  if (schema.type === "object") {
    const obj: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [propKey, propValue] of Object.entries(value)) {
          const value = extractDefaultValues(propValue);
          if (value !== undefined) obj[propKey] = value;
        }
      }
    }

    return Object.entries(obj).length > 0 ? obj : undefined;
  }

  return schema.default;
}

/**
 * Merges objects into a single object, preferring values from later objects.
 * Recursively calls itself for nested objects, passing on any objects that
 * matching properties.
 * @param objects - Objects to merge
 * @returns A merged object, or undefined if no objects provided
 */
export function mergeObjects(...objects: any[]): any {
  objects = objects.filter((obj) => obj !== undefined);
  if (objects.length === 0) return undefined;
  if (objects.length === 1) return objects[0];

  const seen = new Set<PropertyKey>();
  const result: any = {};

  for (const obj of objects) {
    // If we have a literal value, return it. Same for arrays, since we wouldn't
    // know how to merge them. Note that earlier objects take precedence, so if
    // an earlier was e.g. an object, we'll return that instead of the literal.
    if (
      typeof obj !== "object" ||
      obj === null ||
      Array.isArray(obj) ||
      isAlias(obj) ||
      isCellLink(obj) ||
      isDoc(obj) ||
      isCell(obj) ||
      isStatic(obj)
    ) {
      return obj;
    }

    // Then merge objects, only passing those on that have any values.
    for (const key of Object.keys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const merged = mergeObjects(...objects.map((obj) => obj[key]));
      if (merged !== undefined) result[key] = merged;
    }
  }

  return result;
}

/**
 * Sends a value to a binding. If the binding is an array or object, it'll
 * traverse the binding and the value in parallel accordingly. If the binding is
 * an alias, it will follow all aliases and send the value to the last aliased
 * doc. If the binding is a literal, we verify that it matches the value and
 * throw an error otherwise.
 * @param doc - The document context
 * @param binding - The binding to send to
 * @param value - The value to send
 * @param log - Optional reactivity log
 */
export function sendValueToBinding(
  doc: DocImpl<any>,
  binding: any,
  value: any,
  log?: ReactivityLog,
) {
  if (isAlias(binding)) {
    const ref = followAliases(binding, doc, log);
    diffAndUpdate(ref, value, log, { doc, binding });
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(binding.length, value.length); i++) {
        sendValueToBinding(doc, binding[i], value[i], log);
      }
    }
  } else if (typeof binding === "object" && binding !== null) {
    for (const key of Object.keys(binding)) {
      if (key in value) sendValueToBinding(doc, binding[key], value[key], log);
    }
  } else {
    if (binding !== value) {
      throw new Error(`Got ${value} instead of ${binding}`);
    }
  }
}

// Sets a value at a path, following aliases and recursing into objects. Returns
// success, meaning no frozen docs were in the way. That is, also returns true
// if there was no change.
export function setNestedValue(
  doc: DocImpl<any>,
  path: PropertyKey[],
  value: any,
  log?: ReactivityLog,
): boolean {
  const destValue = doc.getAtPath(path);
  if (isAlias(destValue)) {
    const ref = followAliases(destValue, doc, log);
    return setNestedValue(ref.cell, ref.path, value, log);
  }

  // Compare destValue and value, if they are the same, recurse, otherwise write
  // value with setAtPath
  if (
    typeof destValue === "object" &&
    destValue !== null &&
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === Array.isArray(destValue) &&
    !isDoc(value) &&
    !isCellLink(value) &&
    !isCell(value)
  ) {
    let success = true;
    for (const key in value) {
      if (key in destValue) {
        success &&= setNestedValue(
          doc,
          [...path, key],
          value[key],
          log,
        );
      } else {
        if (doc.isFrozen()) success = false;
        else doc.setAtPath([...path, key], value[key], log);
      }
    }
    for (const key in destValue) {
      if (!(key in value)) {
        if (doc.isFrozen()) success = false;
        else doc.setAtPath([...path, key], undefined, log);
      }
    }

    return success;
  } else if (isCellLink(value) && isCellLink(destValue)) {
    if (
      value.cell !== destValue.cell || !arrayEqual(value.path, destValue.path)
    ) {
      doc.setAtPath(path, value, log);
    }
    return true;
  } else if (!Object.is(destValue, value)) {
    // Use Object.is for comparison to handle NaN and -0 correctly
    if (doc.isFrozen()) return false;
    doc.setAtPath(path, value, log);
    return true;
  }

  return true;
}

/**
 * Unwraps one level of aliases, and
 * - binds top-level aliases to passed doc
 * - reduces wrapping count of closure docs by one
 *
 * This is used for arguments to nodes (which can be recipes, e.g. for map) and
 * for the recipe in recipe nodes.
 *
 * An alias will go through these stages:
 * - { $alias: { cell: 1, path: ["a"] } }
 *   = Nested two layers deep, an argment for a nested recipe
 * - { $alias: { path: ["a"] } }
 *   = One layer deep, e.g. a recipe that will be passed to `run`
 * - { $alias: { cell: <doc>, path: ["a"] } }
 *   = Unwrapped, executing the recipe
 *
 * @param binding - The binding to unwrap.
 * @param doc - The doc to bind to.
 * @returns The unwrapped binding.
 */
export function unwrapOneLevelAndBindtoDoc<T>(
  binding: T,
  doc: DocImpl<any>,
): T {
  function convert(binding: any, processStatic = false): any {
    if (isStatic(binding) && !processStatic) {
      return markAsStatic(convert(binding, true));
    } else if (isAlias(binding)) {
      const alias = { ...binding.$alias };
      if (typeof alias.cell === "number") {
        if (alias.cell === 1) {
          // Moved to the next-to-top level. Don't assign a doc, so that on
          // next unwrap, the right doc be assigned.
          delete alias.cell;
        } else {
          alias.cell = alias.cell - 1;
        }
      } else if (!alias.cell) {
        alias.cell = doc;
      }
      return { $alias: alias };
    } else if (isDoc(binding)) {
      return binding; // Don't enter docs
    } else if (Array.isArray(binding)) {
      return binding.map((value) => convert(value));
    } else if (typeof binding === "object" && binding !== null) {
      const result: any = Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [key, convert(value)]),
      );
      if (binding[unsafe_originalRecipe]) {
        result[unsafe_originalRecipe] = binding[unsafe_originalRecipe];
      }
      return result;
    } else return binding;
  }
  return convert(binding) as T;
}

export function unsafe_noteParentOnRecipes(recipe: Recipe, binding: any) {
  if (typeof binding !== "object" || binding === null) return;

  // For now we just do top-level bindings
  for (const key in binding) {
    if (binding[key][unsafe_originalRecipe]) {
      binding[key][unsafe_parentRecipe] = recipe;
    }
  }
}

export function unsafe_createParentBindings(
  recipe: Recipe,
  log: ReactivityLog,
): UnsafeBinding | undefined {
  if (!recipe || !recipe[unsafe_originalRecipe]) return undefined;
  else {
    return {
      recipe: recipe[unsafe_originalRecipe]!,
      materialize: recipe[unsafe_materializeFactory]!(log),
      parent: unsafe_createParentBindings(recipe[unsafe_parentRecipe]!, log),
    };
  }
}

// Traverses binding and returns all docs reacheable through aliases.
export function findAllAliasedCells(
  binding: any,
  doc: DocImpl<any>,
): CellLink[] {
  const docs: CellLink[] = [];
  function find(binding: any, origDoc: DocImpl<any>) {
    if (isAlias(binding)) {
      // Numbered docs are yet to be unwrapped nested recipes. Ignore them.
      if (typeof binding.$alias.cell === "number") return;
      const doc = binding.$alias.cell ?? origDoc;
      const path = binding.$alias.path;
      if (docs.find((c) => c.cell === doc && c.path === path)) return;
      docs.push({ cell: doc, path });
      find(doc.getAtPath(path), doc);
    } else if (Array.isArray(binding)) {
      for (const value of binding) find(value, origDoc);
    } else if (
      typeof binding === "object" &&
      binding !== null &&
      !isCellLink(binding) &&
      !isDoc(binding) &&
      !isCell(binding)
    ) {
      for (const value of Object.values(binding)) find(value, origDoc);
    }
  }
  find(binding, doc);
  return docs;
}

/**
 * Track visited cell links and memoize results during path resolution
 * and link following to prevent redundant work.
 */
interface Visits {
  /** Tracks visited cell links to detect cycles */
  seen: CellLink[];
  /** Cache for resolvePath results */
  resolvePathCache: Map<string, CellLink>;
  /** Cache for followLinks results */
  followLinksCache: Map<string, CellLink>;
}

/**
 * Creates a new visits tracking object.
 */
function createVisits(): Visits {
  return {
    seen: [],
    resolvePathCache: new Map(),
    followLinksCache: new Map(),
  };
}

/**
 * Creates a cache key for a doc and path combination.
 */
function createPathCacheKey(
  doc: DocImpl<any>,
  path: PropertyKey[],
  aliases: boolean = false,
): string {
  return JSON.stringify([doc.space, doc.toJSON(), path, aliases]);
}

export function resolveLinkToValue(
  doc: DocImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): CellLink {
  const visits = createVisits();
  const ref = resolvePath(doc, path, log, schema, rootSchema, visits);
  return followLinks(ref, log, visits);
}

export function resolveLinkToAlias(
  doc: DocImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): CellLink {
  const visits = createVisits();
  const ref = resolvePath(doc, path, log, schema, rootSchema, visits);
  return followLinks(ref, log, visits, true);
}

export function resolveLinks(ref: CellLink, log?: ReactivityLog): CellLink {
  const visits = createVisits();
  return followLinks(ref, log, visits);
}

function resolvePath(
  doc: DocImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
  visits: Visits = createVisits(),
): CellLink { // Follow aliases, doc links, etc. in path, so that we end up on the right
  // doc, meaning the one that contains the value we want to access without any
  // redirects in between.
  //
  // If the path points to a redirect itself, we don't want to follow it: Other
  // functions like followLinks will do that. We just want to skip the interim ones.
  //
  // All taken links are logged, but not the final one.
  //
  // Let's look at a few examples:
  //
  // Doc: { link }, path: [] --> no change
  // Doc: { link }, path: ["foo"] --> follow link, path: ["foo"]
  // Doc: { foo: { link } }, path: ["foo"] --> no change
  // Doc: { foo: { link } }, path: ["foo", "bar"] --> follow link, path: ["bar"]

  // Check if we already resolved this exact path
  const fullPathKey = createPathCacheKey(doc, path);
  const exactMatch = visits.resolvePathCache.get(fullPathKey);
  if (exactMatch) {
    return exactMatch;
  }

  // Try to find a cached result for a shorter path
  let startRef: CellLink = { cell: doc, path: [] };
  let keys = [...path];

  // Look for the longest matching prefix path in the cache
  for (let i = path.length - 1; i >= 0; i--) {
    const prefixPath = path.slice(0, i);
    const prefixKey = createPathCacheKey(doc, prefixPath);
    const prefixMatch = visits.resolvePathCache.get(prefixKey);

    if (prefixMatch) {
      startRef = prefixMatch;
      keys = [...path.slice(i)];
      break;
    }
  }

  const cfc = new ContextualFlowControl();
  let ref = startRef;

  while (keys.length) {
    // First follow all the aliases and links, _before_ accessing the key.
    ref = followLinks(ref, log, visits);

    // Now access the key.
    const key = keys.shift()!;

    const childPath = [...ref.path, key];
    let childSchema = ref.schema;
    if (
      ref.schema === undefined && schema !== undefined &&
      arrayEqual(path, childPath)
    ) {
      // Since path is childPath, restore schema
      childSchema = schema;
    } else {
      childSchema = cfc.getSchemaAtPath(
        ref.schema,
        [key.toString()],
        ref.rootSchema,
      );
    }
    ref = {
      cell: ref.cell,
      path: childPath,
      schema: childSchema,
      rootSchema: childSchema ? ref.rootSchema : undefined,
    };
  }

  // Cache the final result
  visits.resolvePathCache.set(fullPathKey, ref);
  return ref;
}

// Follows links and returns the last one, which is pointing to a value. It'll
// log all taken links, so not the returned one, and thus nothing if the ref
// already pointed to a value.
function followLinks(
  ref: CellLink,
  log: ReactivityLog | undefined,
  visits: Visits,
  onlyAliases = false,
): CellLink {
  // Check if we already followed these links
  const cacheKey = createPathCacheKey(ref.cell, ref.path, onlyAliases);
  const cached = visits.followLinksCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let nextRef: CellLink | undefined;
  let result = ref;

  do {
    const resolvedRef = resolvePath(
      result.cell,
      result.path,
      log,
      result.schema,
      result.rootSchema,
      visits,
    );

    // Add schema back if we didn't get a new one
    if (!resolvedRef.schema && result.schema) {
      result = { ...resolvedRef, schema: result.schema };
      if (result.rootSchema) resolvedRef.rootSchema = result.rootSchema;
    } else {
      result = resolvedRef;
    }

    const target = result.cell.getAtPath(result.path);

    nextRef = !onlyAliases || isAlias(target)
      ? maybeGetCellLink(target, result.cell)
      : undefined;

    if (nextRef !== undefined) {
      // Add schema back if we didn't get a new one
      if (!nextRef.schema && result.schema) {
        nextRef = {
          ...nextRef,
          schema: result.schema,
        };
        if (result.rootSchema) nextRef.rootSchema = result.rootSchema;
      }

      // Log all the refs that were followed, but not the final value they point to.
      log?.reads.push({ ...result });

      result = nextRef;

      // Detect cycles (at this point these are all references that point to something)
      if (
        visits.seen.some((r) =>
          r.cell === result.cell && arrayEqual(r.path, result.path)
        )
      ) {
        throw new Error(
          `Reference cycle detected ${
            JSON.stringify(result.cell.entityId ?? "unknown")
          }/[${result.path.join(", ")}] ${JSON.stringify(visits.seen)}`,
        );
      }
      visits.seen.push(result);
    }
  } while (nextRef);

  // Cache the result
  visits.followLinksCache.set(cacheKey, result);
  return result;
}

export function maybeGetCellLink(
  value: any,
  parent?: DocImpl<any>,
): CellLink | undefined {
  if (isQueryResultForDereferencing(value)) return getCellLinkOrThrow(value);
  else if (isCellLink(value)) return value;
  else if (isAlias(value)) return { cell: parent, ...value.$alias } as CellLink;
  else if (isDoc(value)) return { cell: value, path: [] } satisfies CellLink;
  else if (isCell(value)) return value.getAsCellLink();
  else return undefined;
}

// Follows aliases and returns cell reference describing the last alias.
// Only logs interim aliases, not the first one, and not the non-alias value.
export function followAliases(
  alias: any,
  doc: DocImpl<any>,
  log?: ReactivityLog,
): CellLink {
  if (!isAlias(alias)) {
    throw new Error(`Alias expected: ${JSON.stringify(alias)}`);
  }

  return followLinks({ cell: doc, ...alias.$alias }, log, createVisits(), true);
}

/**
 * Traverses newValue and updates `current` and any relevant linked documents.
 *
 * Returns true if any changes were made.
 *
 * When encountering an object with a `[ID]` property, it'll be used to compute
 * an entity id based on it's relative location and the passed context, and the
 * changes will be written to that entity.
 *
 * @param current - A doc link to the current value to compare against.
 * @param newValue - The new value to traverse.
 * @param log - The log to write to.
 * @param context - The context of the change.
 * @returns Whether any changes were made.
 */
export function diffAndUpdate(
  current: CellLink,
  newValue: any,
  log?: ReactivityLog,
  context?: any,
): boolean {
  const changes = normalizeAndDiff(current, newValue, log, context);
  applyChangeSet(changes, log);
  return changes.length > 0;
}

type ChangeSet = { location: CellLink; value: any }[];

/**
 * Traverses objects and returns an array of changes that should be written. An
 * empty array means no changes.
 *
 * When encountering an object with a `[ID]` property, it'll be used to compute
 * an entity id based on it's relative location and the passed context, and the
 * changes will be queued to be written to that entity.
 *
 * Otherwise, when traversing and if the new value is a regular JSON value, but
 * the old value is an alias, follow the alias before writing. However document
 * references get overwritten (except as per above, the object gets converted to
 * a document itself).
 *
 * Any proxy is unwrapped, and docs and cells mapped to doc links.
 *
 * @param current - A doc link to the current value to compare against.
 * @param newValue - The new value to traverse.
 * @param log - The log to write to.
 * @param context - The context of the change.
 * @returns An array of changes that should be written.
 */
export function normalizeAndDiff(
  current: CellLink,
  newValue: any,
  log?: ReactivityLog,
  context?: any,
): ChangeSet {
  const changes: ChangeSet = [];

  // ID_FIELD redirects to an existing field and we do something like DOM
  // diffing with it: We look at sibling entries and their value for that field,
  // and if we find a match, we reuse that document. Otherwise we create a new
  // one, but with a random id. It's random as opposed to causal like ID below,
  // because we don't want to recycle a document that was removed and added
  // back, we want to assume removing and adding with the same id is
  // semantically a new item (in fact we otherwise run into compare-and-swap
  // transaction errors).
  if (
    typeof newValue === "object" && newValue !== null &&
    newValue[ID_FIELD] !== undefined
  ) {
    const { [ID_FIELD]: fieldName, ...rest } = newValue;
    const id = newValue[fieldName];
    if (current.path.length > 1) {
      const parent = current.cell.getAtPath(current.path.slice(0, -1));
      if (Array.isArray(parent)) {
        for (const v of parent) {
          if (isCellLink(v)) {
            const sibling = v.cell.getAtPath(v.path);
            if (
              typeof sibling === "object" && sibling !== null &&
              sibling[fieldName] === id
            ) {
              // We found a sibling with the same id, so ...
              return [
                // ... reuse the existing document
                ...normalizeAndDiff(current, v, log, context),
                // ... and update it to the new value
                ...normalizeAndDiff(v, rest, log, context),
              ];
            }
          }
        }
      }
    }
    // Fallback: A random id. Below this will create a new entity.
    newValue = { [ID]: crypto.randomUUID(), ...rest };
  }

  // Unwrap proxies and handle special types
  newValue = maybeUnwrapProxy(newValue);
  if (isDoc(newValue)) newValue = { cell: newValue, path: [] };
  if (isCell(newValue)) newValue = newValue.getAsCellLink();

  // Get current value to compare against
  const currentValue = current.cell.getAtPath(current.path);

  // A new alias can overwrite a previous alias. No-op if the same.
  if (isAlias(newValue)) {
    if (
      isAlias(currentValue) &&
      newValue.$alias.cell === currentValue.$alias.cell &&
      arrayEqual(newValue.$alias.path, currentValue.$alias.path)
    ) {
      return [];
    } else {
      changes.push({ location: current, value: newValue });
      return changes;
    }
  }

  // Handle alias in current value (at this point: if newValue is not an alias)
  if (isAlias(currentValue)) {
    // Log reads of the alias, so that changing aliases cause refreshes
    log?.reads.push({ ...current });
    const ref = followAliases(currentValue, current.cell, log);
    return normalizeAndDiff(ref, newValue, log, context);
  }

  if (isCellLink(newValue)) {
    if (
      isCellLink(currentValue) &&
      currentValue.cell === newValue.cell &&
      arrayEqual(currentValue.path, newValue.path)
    ) {
      return [];
    } else {
      return [
        { location: current, value: newValue },
      ];
    }
  }

  // Handle ID-based object (convert to entity)
  if (
    typeof newValue === "object" && newValue !== null &&
    newValue[ID] !== undefined
  ) {
    const { [ID]: id, ...rest } = newValue;
    let path = current.path;

    // If we're setting an array element, make the array the context for the
    // derived id, not the array index. If it's a nested array, take the parent
    // array as context, recursively.
    while (
      path.length > 0 &&
      Array.isArray(current.cell.getAtPath(path.slice(0, -1)))
    ) {
      path = path.slice(0, -1);
    }

    const entityId = createRef({ id }, { parent: current.cell, path, context });
    const doc = getDocByEntityId(
      current.cell.space,
      entityId,
      true,
      current.cell,
    )!;
    const ref = {
      cell: doc,
      path: [],
      schema: current.schema,
      rootSchema: current.rootSchema,
    };
    return [
      // If it wasn't already, set the current value to be a doc link to this doc
      ...normalizeAndDiff(current, ref, log, context),
      // And see whether the value of the document itself changed
      ...normalizeAndDiff(ref, rest, log, context),
    ];
  }

  const cfc = new ContextualFlowControl();
  // Handle arrays
  if (Array.isArray(newValue)) {
    // If the current value is not an array, set it to an empty array
    if (!Array.isArray(currentValue)) {
      changes.push({ location: current, value: [] });
    }

    for (let i = 0; i < newValue.length; i++) {
      const childSchema = cfc.getSchemaAtPath(
        current.schema,
        [i.toString()],
        current.rootSchema,
      );
      const nestedChanges = normalizeAndDiff(
        {
          cell: current.cell,
          path: [...current.path, i.toString()],
          schema: childSchema,
          rootSchema: current.rootSchema,
        },
        newValue[i],
        log,
        context,
      );
      changes.push(...nestedChanges);
    }

    // Handle array length changes
    if (Array.isArray(currentValue) && currentValue.length > newValue.length) {
      // We need to add the schema here, since the array may be secret, so the length should be too
      const lub = (current.schema !== undefined)
        ? cfc.lubSchema(current.schema)
        : undefined;
      // We have to cast these, since the type could be changed to another value
      const childSchema = (lub !== undefined)
        ? { type: "number", ifc: { classification: [lub] } } as JSONSchema
        : { type: "number" } as JSONSchema;
      changes.push({
        location: {
          cell: current.cell,
          path: [...current.path, "length"],
          schema: childSchema,
          rootSchema: current.rootSchema,
        },
        value: newValue.length,
      });
    }

    return changes;
  }

  // Handle objects
  if (typeof newValue === "object" && newValue !== null) {
    // If the current value is not a (regular) object, set it to an empty object
    // Note that the alias case is handled above
    if (
      typeof currentValue !== "object" || currentValue === null ||
      isCellLink(currentValue)
    ) {
      changes.push({ location: current, value: {} });
    }

    for (const key in newValue) {
      const childSchema = cfc.getSchemaAtPath(
        current.schema,
        [key],
        current.rootSchema,
      );
      const nestedChanges = normalizeAndDiff(
        {
          cell: current.cell,
          path: [...current.path, key],
          schema: childSchema,
          rootSchema: current.rootSchema,
        },
        newValue[key],
        log,
        context,
      );
      changes.push(...nestedChanges);
    }

    // Handle removed keys
    for (const key in currentValue) {
      if (!(key in newValue)) {
        const childSchema = cfc.getSchemaAtPath(
          current.schema,
          [key],
          current.rootSchema,
        );
        changes.push({
          location: {
            cell: current.cell,
            path: [...current.path, key],
            schema: childSchema,
            rootSchema: current.rootSchema,
          },
          value: undefined,
        });
      }
    }

    return changes;
  }

  // Handle primitive values and other cases
  if (!Object.is(currentValue, newValue)) {
    changes.push({ location: current, value: newValue });
  }

  return changes;
}

/**
 * Apply a change set to all mentioned documents.
 *
 * @param changes - The change set to apply.
 * @param log - The log to write to.
 */
export function applyChangeSet(
  changes: ChangeSet,
  log?: ReactivityLog,
) {
  for (const change of changes) {
    change.location.cell.setAtPath(
      change.location.path,
      change.value,
      undefined,
      change.location.schema,
    );
    log?.writes.push(change.location);
  }
}

/**
 * Translates `id` that React likes to create to our `ID` property, making sure
 * in any given object it is never used twice.
 *
 * This mostly makes sense in a context where we ship entire JSON documents back
 * and forth and can't express graphs, i.e. two places referring to the same
 * underlying entity.
 *
 * We'll want to revisit once iframes become more sophisticated in what they can
 * express, e.g. we could have the inner shim do some of this work instead.
 */
export function addCommonIDfromObjectID(obj: any, fieldName: string = "id") {
  function traverse(obj: any) {
    if (typeof obj === "object" && obj !== null && fieldName in obj) {
      obj[ID_FIELD] = fieldName;
    }

    if (
      typeof obj === "object" && obj !== null && !isCell(obj) &&
      !isCellLink(obj) && !isDoc(obj)
    ) {
      Object.values(obj).forEach((v: any) => {
        traverse(v);
      });
    }
  }

  traverse(obj);
}

export function maybeUnwrapProxy(value: any): any {
  return isQueryResultForDereferencing(value)
    ? getCellLinkOrThrow(value)
    : value;
}

export function arrayEqual(a: PropertyKey[], b: PropertyKey[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isEqualCellLink(a: CellLink, b: CellLink): boolean {
  return isCellLink(a) && isCellLink(b) && a.cell === b.cell &&
    arrayEqual(a.path, b.path);
}

export function containsOpaqueRef(value: any): boolean {
  if (isOpaqueRef(value)) return true;
  if (isCell(value) || isCellLink(value) || isDoc(value)) return false;
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsOpaqueRef);
  }
  return false;
}

export function deepCopy(value: any): any {
  if (isQueryResultForDereferencing(value)) {
    return deepCopy(getCellLinkOrThrow(value));
  }
  if (isDoc(value) || isCell(value)) return value;
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? value.map(deepCopy) : Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, deepCopy(value)]),
    );
  } else return value;
}
