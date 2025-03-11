import {
  ID,
  isAlias,
  isOpaqueRef,
  isStatic,
  markAsStatic,
  type Recipe,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  UnsafeBinding,
} from "@commontools/builder";
import { type DocImpl, type DocLink, getDoc, isDoc, isDocLink } from "./doc.ts";
import {
  getDocLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { isCell } from "./cell.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { createRef, getDocByEntityId } from "./doc-map.ts";

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

// Merges objects into a single object, preferring values from later objects.
// Recursively calls itself for nested objects, passing on any objects that
// matching properties.
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
      isDocLink(obj) ||
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

// Sends a value to a binding. If the binding is an array or object, it'll
// traverse the binding and the value in parallel accordingly. If the binding is
// an alias, it will follow all aliases and send the value to the last aliased
// doc. If the binding is a literal, we verify that it matches the value and
// throw an error otherwise.
export function sendValueToBinding(
  doc: DocImpl<any>,
  binding: any,
  value: any,
  log?: ReactivityLog,
) {
  if (isAlias(binding)) {
    const ref = followAliases(binding, doc, log);
    if (!isDocLink(value) && !isDoc(value) && !isAlias(value)) {
      normalizeToDocLinks(
        doc,
        value,
        ref.cell.getAtPath(ref.path),
        log,
        binding,
      );
    }
    setNestedValue(ref.cell, ref.path, value, log);
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
    !isDocLink(value) &&
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
  } else if (isDocLink(value) && isDocLink(destValue)) {
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
      if (typeof binding.$alias.cell === "number") {
        if (binding.$alias.cell === 1) {
          // Moved to the next-to-top level. Don't assign a doc, so that on
          // next unwrap, the right doc be assigned.
          return { $alias: { path: binding.$alias.path } };
        } else {
          return {
            // Otherwise decrease count by one
            $alias: {
              cell: binding.$alias.cell - 1,
              path: binding.$alias.path,
            },
          };
        }
      } else {
        return {
          // Bind to passed doc, if there isn't already one
          $alias: {
            cell: binding.$alias.cell ?? doc,
            path: binding.$alias.path,
          },
        };
      }
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
export function findAllAliasedDocs(
  binding: any,
  doc: DocImpl<any>,
): DocLink[] {
  const docs: DocLink[] = [];
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
      !isDocLink(binding) &&
      !isDoc(binding) &&
      !isCell(binding)
    ) {
      for (const value of Object.values(binding)) find(value, origDoc);
    }
  }
  find(binding, doc);
  return docs;
}

export function resolveLinkToValue(
  doc: DocImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog,
  seen: DocLink[] = [],
): DocLink {
  const ref = resolvePath(doc, path, log, seen);
  return followLinks(ref, seen, log);
}

export function resolvePath(
  doc: DocImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog,
  seen: DocLink[] = [],
): DocLink {
  // Follow aliases, doc links, etc. in path, so that we end up on the right
  // doc, meaning the one that contains the value we want to access without any
  // redirects in between.
  //
  // If the path points to a redirect itself, we don't want to follow it: Other
  // functions like followLwill do that. We just want to skip the interim ones.
  //
  // All taken links are logged, but not the final one.
  //
  // Let's look at a few examples:
  //
  // Doc: { link }, path: [] --> no change
  // Doc: { link }, path: ["foo"] --> follow link, path: ["foo"]
  // Doc: { foo: { link } }, path: ["foo"] --> no change
  // Doc: { foo: { link } }, path: ["foo", "bar"] --> follow link, path: ["bar"]

  let ref: DocLink = { cell: doc, path: [] };

  const keys = [...path];
  while (keys.length) {
    // First follow all the aliases and links, _before_ accessing the key.
    ref = followLinks(ref, seen, log);

    // Now access the key.
    const key = keys.shift()!;
    ref = { cell: ref.cell, path: [...ref.path, key] };
  }

  // Follow aliases on the last key, but no other kinds of links.
  if (isAlias(ref.cell.getAtPath(ref.path))) {
    log?.reads.push({ cell: ref.cell, path: ref.path });
    ref = followAliases(ref.cell.getAtPath(ref.path), ref.cell, log);
  }

  return ref;
}

// Follows links and returns the last one, which is pointing to a value. It'll
// log all taken links, so not the returned one, and thus nothing if the ref
// already pointed to a value.
export function followLinks(
  ref: DocLink,
  seen: DocLink[] = [],
  log?: ReactivityLog,
): DocLink {
  let nextRef: DocLink | undefined;

  do {
    ref = resolvePath(ref.cell, ref.path, log, seen);
    const target = ref.cell.getAtPath(ref.path);

    nextRef = undefined;
    if (isQueryResultForDereferencing(target)) {
      nextRef = getDocLinkOrThrow(target);
    } else if (isCell(target)) nextRef = target.getAsDocLink();
    else if (isDocLink(target)) nextRef = target;
    else if (isDoc(target)) {
      nextRef = { cell: target, path: [] } satisfies DocLink;
    } else if (isAlias(target)) {
      nextRef = {
        cell: target.$alias.cell ?? ref.cell,
        path: target.$alias.path,
      } satisfies DocLink;
    }

    if (nextRef) {
      // Log all the refs that were followed, but not the final value they point to.
      log?.reads.push({ cell: ref.cell, path: ref.path });

      ref = nextRef;

      // Detect cycles (at this point these are all references that point to something)
      if (
        seen.some((r) => r.cell === ref.cell && arrayEqual(r.path, ref.path))
      ) {
        throw new Error(
          `Reference cycle detected ${
            JSON.stringify(ref.cell.entityId ?? "unknown")
          } ${ref.path.join(".")}`,
        );
      }
      seen.push(ref);
    }
  } while (nextRef);

  return ref;
}

// Follows cell references and returns the last one
export function followCellReferences(
  reference: DocLink,
  log?: ReactivityLog,
): any {
  const seen = new Set<DocLink>();
  let result = reference;

  while (isDocLink(reference)) {
    log?.reads.push({ cell: reference.cell, path: reference.path });
    result = reference;
    if (seen.has(reference)) throw new Error("Reference cycle detected");
    seen.add(reference);
    reference = reference.cell.getAtPath(reference.path);
  }

  return result;
}

// Follows aliases and returns cell reference describing the last alias.
// Only logs interim aliases, not the first one, and not the non-alias value.
export function followAliases(
  alias: any,
  cell: DocImpl<any>,
  log?: ReactivityLog,
): DocLink {
  const seen = new Set<any>();
  let result: DocLink;

  while (isAlias(alias)) {
    if (alias.$alias.cell) cell = alias.$alias.cell;
    result = { cell, path: alias.$alias.path };

    if (seen.has(alias)) throw new Error("Alias cycle detected");
    seen.add(alias);
    alias = cell.getAtPath(alias.$alias.path);
    if (isAlias(alias)) log?.reads.push({ cell, path: alias.$alias.path });
  }

  return result!;
}

export type ChangeSet = { location: DocLink; value: any }[];

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
  current: DocLink,
  newValue: any,
  log?: ReactivityLog,
  context?: any,
): ChangeSet {
  const changes: ChangeSet = [];

  // Unwrap proxies and handle special types
  newValue = maybeUnwrapProxy(newValue);
  if (isDoc(newValue)) newValue = { cell: newValue, path: [] };
  if (isCell(newValue)) newValue = newValue.getAsDocLink();

  // Get current value to compare against
  const currentValue = current.cell.getAtPath(current.path);
  log?.reads.push({ cell: current.cell, path: current.path });

  // Handle alias in current value
  if (isAlias(currentValue)) {
    const ref = followAliases(currentValue, current.cell, log);
    return normalizeAndDiff(ref, newValue, log, context);
  }

  if (isDocLink(currentValue) && isDocLink(newValue)) {
    if (
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
    const entityId = createRef(id, {
      parent: current.cell,
      path: current.path,
      context: context,
    });
    const doc = getDocByEntityId(
      current.cell.space,
      entityId,
      true,
      current.cell,
    )!;
    const ref = { cell: doc, path: [] };
    return [
      // If it wasn't already, set the current value to be a doc link to this doc
      ...normalizeAndDiff(current, ref, log, context),
      // And see whether the value of the document itself changed
      ...normalizeAndDiff(ref, rest, log, context),
    ];
  }

  // Handle arrays
  if (Array.isArray(newValue) && Array.isArray(currentValue)) {
    for (let i = 0; i < newValue.length; i++) {
      const nestedChanges = normalizeAndDiff(
        { cell: current.cell, path: [...current.path, i] },
        newValue[i],
        log,
        context,
      );
      changes.push(...nestedChanges);
    }

    // Handle array length changes
    if (currentValue.length > newValue.length) {
      changes.push({
        location: { cell: current.cell, path: [...current.path, "length"] },
        value: newValue.length,
      });
    }

    return changes;
  }

  // Handle objects
  if (
    typeof newValue === "object" && newValue !== null &&
    typeof currentValue === "object" && currentValue !== null &&
    !Array.isArray(newValue) && !Array.isArray(currentValue) &&
    !isDocLink(newValue) && !isDocLink(currentValue) &&
    !isAlias(newValue) && !isAlias(currentValue)
  ) {
    for (const key in newValue) {
      const nestedChanges = normalizeAndDiff(
        { cell: current.cell, path: [...current.path, key] },
        newValue[key],
        log,
        context,
      );
      changes.push(...nestedChanges);
    }

    // Handle removed keys
    for (const key in currentValue) {
      if (!(key in newValue)) {
        changes.push({
          location: { cell: current.cell, path: [...current.path, key] },
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
    change.location.cell.setAtPath(change.location.path, change.value);
    log?.writes.push(change.location);
  }
}

/**
 * Ensures that all elements of an array are docs. If not, i.e. they are static
 * data, turn them into doc links. "Is a doc" means it's either a doc, a doc
 * link or an alias.
 *
 * Pass the previous value to reuse docs from previous transitions. It does so
 * if the values match, but only on arrays (as for objects we don't (yet?) do
 * this behind the scenes translation).
 *
 * @param value - The value to traverse and make sure all arrays are arrays of
 * docs.
 * @returns Whether the value was changed.
 */
export function normalizeToDocLinks(
  parentDoc: DocImpl<any>,
  value: any,
  previous?: any,
  log?: ReactivityLog,
  cause: any = createRef(),
): boolean {
  value = maybeUnwrapProxy(value);
  previous = maybeUnwrapProxy(previous);

  let changed = false;
  if (isStatic(value)) {
    // no-op, don't normalize deep static values and assume they don't change
  } else if (isDoc(value) || isCell(value)) {
    changed = value !== previous;
  } else if (isDocLink(value)) {
    changed = isDocLink(previous)
      ? value.cell !== previous.cell || !arrayEqual(value.path, previous.path)
      : true;
  } else if (isAlias(value)) {
    changed = isAlias(previous)
      ? value.$alias.cell !== previous.$alias.cell ||
        !arrayEqual(value.$alias.path, previous.$alias.path)
      : true;
  } else if (Array.isArray(value)) {
    if (!Array.isArray(previous)) {
      previous = undefined;
      changed = true;
    } else if (value.length !== previous.length) {
      changed = true;
    }
    let itemId = null;
    let preceedingItemId = null;
    for (let i = 0; i < value.length; i++) {
      let item = maybeUnwrapProxy(value[i]);
      if (isCell(item)) item = item.getAsDocLink();
      if (item !== value[i]) value[i] = item; // Capture unwrapped value
      const previousItem = previous ? maybeUnwrapProxy(previous[i]) : undefined;
      if (!(isDoc(item) || isDocLink(item) || isAlias(item))) {
        // TODO(seefeld): Should this depend on the value if there is no id provided?
        // This is probably generating extra churn on ids.
        itemId = typeof item === "object" && item !== null && "id" in item
          ? createRef({ id: item.id }, { parent: cause })
          : createRef(value[i], {
            parent: cause,
            index: i,
            preceeding: preceedingItemId,
          });
        const different = normalizeToDocLinks(
          parentDoc,
          value[i],
          isDocLink(previousItem)
            ? previousItem.cell.getAtPath(previousItem.path)
            : previousItem,
          log,
          isDocLink(previousItem)
            ? (previousItem.cell.entityId ?? itemId)
            : itemId,
        );
        if (!different && previous && previous[i] && isDocLink(previous[i])) {
          value[i] = previous[i];
          preceedingItemId = previousItem.cell.entityId;
          // NOTE: We don't treat making it a cell reference as a change, since
          // we'll still have the same value. This is reusing the cell reference
          // transition from a previous run, but only if the value didn't
          // change as well.
        } else {
          const doc = getDocByEntityId(
            parentDoc.space,
            itemId,
            true,
            parentDoc,
          )!;
          doc.send(value[i]);
          value[i] = { cell: doc, path: [] };
          log?.writes.push(value[i]);

          preceedingItemId = itemId;
          changed = true;
        }
      }
    }
  } else if (typeof value === "object" && value !== null) {
    if (typeof previous !== "object" || previous === null) {
      previous = undefined;
      changed = true;
    }
    for (const key in value) {
      const item = maybeUnwrapProxy(value[key]);
      if (item !== value[key]) value[key] = item; // Capture unwrapped value
      const previousItem = previous
        ? maybeUnwrapProxy(previous[key])
        : undefined;
      const change = normalizeToDocLinks(parentDoc, item, previousItem, log, {
        parent: cause,
        key,
      });
      changed ||= change;
    }
    if (!changed) {
      for (const key in previous) {
        if (!(key in value)) {
          changed = true;
          break;
        }
      }
    }
  } else if (isDocLink(previous)) {
    // value is a literal value here and the last clause
    changed = value !== previous.cell.getAtPath(previous.path);
  } else if (isCell(previous)) {
    changed = value !== previous.get();
  } else {
    changed = value !== previous;
  }
  return changed;
}

export function prepareForSaving(
  doc: DocImpl<any>,
  value: any,
  previous?: any,
  log?: ReactivityLog,
  cause?: any,
): any {
  if (isCell(value)) return value.getAsDocLink();
  else if (isDocLink(value)) return value;
  else if (isDoc(value)) return { cell: value, path: [] };
  else return normalizeToDocLinks(doc, value, previous, log, cause);
}

export function maybeUnwrapProxy(value: any): any {
  return isQueryResultForDereferencing(value)
    ? getDocLinkOrThrow(value)
    : value;
}

export function arrayEqual(a: PropertyKey[], b: PropertyKey[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isEqualCellReferences(a: DocLink, b: DocLink): boolean {
  return isDocLink(a) && isDocLink(b) && a.cell === b.cell &&
    arrayEqual(a.path, b.path);
}

export function containsOpaqueRef(value: any): boolean {
  if (isOpaqueRef(value)) return true;
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsOpaqueRef);
  }
  return false;
}

export function deepCopy(value: any): any {
  if (isQueryResultForDereferencing(value)) {
    return deepCopy(getDocLinkOrThrow(value));
  }
  if (isDoc(value) || isCell(value)) return value;
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? value.map(deepCopy) : Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, deepCopy(value)]),
    );
  } else return value;
}
