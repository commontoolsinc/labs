import { isRecord } from "@commontools/utils/types";
import {
  ID,
  ID_FIELD,
  type JSONSchema,
  type JSONValue,
} from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { createRef } from "./doc-map.ts";
import {
  type CellLink,
  isAnyCellLink,
  isCell,
  isCellLink,
  type LegacyAlias,
  type SigilAlias,
} from "./cell.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { followAliases } from "./link-resolution.ts";
import { arrayEqual, maybeUnwrapProxy } from "./type-utils.ts";
import { areLinksSame, isAlias, isLink, parseAlias } from "./link-utils.ts";

// Sets a value at a path, following aliases and recursing into objects. Returns
// success, meaning no frozen docs were in the way. That is, also returns true
// if there was no change.
export function setNestedValue<T>(
  doc: DocImpl<T>,
  path: PropertyKey[],
  value: unknown,
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
    isRecord(destValue) &&
    isRecord(value) &&
    Array.isArray(value) === Array.isArray(destValue) &&
    !isDoc(value) &&
    !isAnyCellLink(value) &&
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
  } else if (isLink(value) && isLink(destValue)) {
    // Use the new link comparison function that supports all formats
    if (!areLinksSame(value, destValue, doc.asCell())) {
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
  newValue: unknown,
  log?: ReactivityLog,
  context?: unknown,
): boolean {
  const changes = normalizeAndDiff(current, newValue, log, context);
  applyChangeSet(changes, log);
  return changes.length > 0;
}

type ChangeSet = { location: CellLink; value: unknown }[];

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
  newValue: unknown,
  log?: ReactivityLog,
  context?: unknown,
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
    isRecord(newValue) &&
    newValue[ID_FIELD] !== undefined
  ) {
    const { [ID_FIELD]: fieldName, ...rest } = newValue;
    const id = newValue[fieldName as PropertyKey];
    if (current.path.length > 1) {
      const parent = current.cell.getAtPath(current.path.slice(0, -1));
      if (Array.isArray(parent)) {
        for (const v of parent) {
          if (isCellLink(v)) {
            const sibling = v.cell.getAtPath(v.path);
            if (
              isRecord(sibling) &&
              sibling[fieldName as PropertyKey] === id
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
    const alias = parseAlias(newValue)!;
    const currentAlias = parseAlias(currentValue);
    if (
      currentAlias !== undefined &&
      alias.id === currentAlias.id &&
      arrayEqual(alias.path, currentAlias.path)
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

  if (isAnyCellLink(newValue)) {
    if (
      isAnyCellLink(currentValue) &&
      areLinksSame(newValue, currentValue, current.cell.asCell())
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
    isRecord(newValue) &&
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

    const entityId = createRef({ id }, {
      parent: current.cell.entityId,
      path,
      context,
    });
    const doc = current.cell.runtime.documentMap.getDocByEntityId(
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
  if (isRecord(newValue)) {
    // If the current value is not a (regular) object, set it to an empty object
    // Note that the alias case is handled above
    if (
      typeof currentValue !== "object" || currentValue === null ||
      isAnyCellLink(currentValue)
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
export function addCommonIDfromObjectID(
  obj: unknown,
  fieldName: string = "id",
): void {
  function traverse(obj: unknown): void {
    if (isRecord(obj) && fieldName in obj) {
      obj[ID_FIELD] = fieldName;
    }

    if (
      isRecord(obj) && !isCell(obj) &&
      !isAnyCellLink(obj) && !isDoc(obj)
    ) {
      Object.values(obj).forEach((v) => traverse(v));
    }
  }

  traverse(obj);
}
