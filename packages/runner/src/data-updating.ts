import { isRecord } from "@commontools/utils/types";
import { ID, ID_FIELD, type JSONSchema } from "./builder/types.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { createRef } from "./doc-map.ts";
import { isCell } from "./cell.ts";
import { followWriteRedirects } from "./link-resolution.ts";
import {
  areLinksSame,
  areMaybeLinkAndNormalizedLinkSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  isAnyCellLink,
  isLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { isQueryResultForDereferencing } from "./query-result-proxy.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
  type JSONValue,
} from "./storage/interface.ts";
import { type IRuntime } from "./runtime.ts";
import { toURI } from "./uri-utils.ts";

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
  runtime: IRuntime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: IReadOptions,
): boolean {
  const changes = normalizeAndDiff(
    runtime,
    tx,
    link,
    newValue,
    context,
    options,
  );
  applyChangeSet(tx, changes);
  return changes.length > 0;
}

type ChangeSet = {
  location: NormalizedFullLink;
  value: JSONValue | undefined;
}[];

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
  runtime: IRuntime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: IReadOptions,
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
    const { [ID_FIELD]: fieldName, ...rest } = newValue as
      & { [ID_FIELD]: string }
      & Record<string, JSONValue>;
    const id = newValue[fieldName as PropertyKey];
    if (link.path.length > 1) {
      const parent = tx.readValueOrThrow({
        ...link,
        path: link.path.slice(0, -1),
      }, options);
      if (Array.isArray(parent)) {
        const base = runtime.getCellFromLink(link, undefined, tx);
        for (const v of parent) {
          if (isLink(v)) {
            const sibling = parseLink(v, base);
            const siblingId = tx.readValueOrThrow({
              ...sibling,
              path: [...sibling.path, fieldName as string],
            }, options);
            if (siblingId === id) {
              // We found a sibling with the same id, so ...
              return [
                // ... reuse the existing document
                ...normalizeAndDiff(runtime, tx, link, v, context, options),
                // ... and update it to the new value
                ...normalizeAndDiff(
                  runtime,
                  tx,
                  sibling,
                  rest,
                  context,
                  options,
                ),
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
  if (isQueryResultForDereferencing(newValue)) {
    newValue = createSigilLinkFromParsedLink(parseLink(newValue));
  }

  if (isDoc(newValue)) {
    throw new Error("Docs are not supported anymore");
  }
  if (isCell(newValue)) newValue = newValue.getAsLink();

  // If we're about to create a reference to ourselves, no-op
  if (areMaybeLinkAndNormalizedLinkSame(newValue, link)) {
    return [];
  }

  // Get current value to compare against
  let currentValue = tx.readValueOrThrow(link, options);

  // A new alias can overwrite a previous alias. No-op if the same.
  if (isWriteRedirectLink(newValue)) {
    if (
      isWriteRedirectLink(currentValue) &&
      areNormalizedLinksSame(parseLink(currentValue, link), link)
    ) {
      return [];
    } else {
      changes.push({ location: link, value: newValue as JSONValue });
      return changes;
    }
  }

  // Handle alias in current value (at this point: if newValue is not an alias)
  if (isWriteRedirectLink(currentValue)) {
    // Log reads of the alias, so that changing aliases cause refreshes
    const redirectLink = followWriteRedirects(tx, currentValue, link);
    return normalizeAndDiff(
      runtime,
      tx,
      redirectLink,
      newValue,
      context,
      options,
    );
  }

  if (isAnyCellLink(newValue)) {
    const parsedLink = parseLink(newValue, link);
    if (parsedLink.id.startsWith("data:")) {
      // If there is a data link treat it as writing it's contents instead.

      // TODO(seefeld): If the data url had a space different than the
      // destination, the expectation would be that links inside of it would be
      // resolved against that space as base. This is currently broken (and
      // might also be broken for other relative links)

      //  Use the tx code to make sure we read it the same way
      const dataValue = runtime.edit().readValueOrThrow(parsedLink, options);
      return normalizeAndDiff(runtime, tx, link, dataValue, context, options);
    }
    if (
      isAnyCellLink(currentValue) &&
      areLinksSame(newValue, currentValue, link)
    ) {
      return [];
    } else {
      return [
        // TODO(seefeld): Normalize the link to a sigil link?
        { location: link, value: newValue as JSONValue },
      ];
    }
  }

  // Handle ID-based object (convert to entity)
  if (isRecord(newValue) && newValue[ID] !== undefined) {
    const { [ID]: id, ...rest } = newValue as
      & { [ID]: string }
      & Record<string, JSONValue>;
    let path = link.path;

    // If we're setting an array element, make the array the context for the
    // derived id, not the array index. If it's a nested array, take the parent
    // array as context, recursively.
    while (
      path.length > 0 &&
      Array.isArray(
        tx.readValueOrThrow({ ...link, path: path.slice(0, -1) }, options),
      )
    ) {
      path = path.slice(0, -1);
    }

    const entityId = createRef({ id }, {
      parent: { id: link.id, space: link.space },
      path,
      context,
    });

    const newEntryLink: NormalizedFullLink = {
      id: toURI(entityId),
      space: link.space,
      path: [],
      type: link.type,
    };
    return [
      // If it wasn't already, set the current value to be a doc link to this doc
      ...normalizeAndDiff(
        runtime,
        tx,
        link,
        createSigilLinkFromParsedLink(newEntryLink, { base: link }),
        context,
        options,
      ),
      // And see whether the value of the document itself changed
      ...normalizeAndDiff(runtime, tx, newEntryLink, rest, context, options),
    ];
  }

  // Handle arrays
  if (Array.isArray(newValue)) {
    // If the current value is not an array, set it to an empty array
    if (!Array.isArray(currentValue)) {
      changes.push({ location: link, value: [] });
    }

    for (let i = 0; i < newValue.length; i++) {
      const childSchema = runtime.cfc.getSchemaAtPath(
        link.schema,
        [i.toString()],
        link.rootSchema,
      );
      const nestedChanges = normalizeAndDiff(
        runtime,
        tx,
        {
          ...link,
          path: [...link.path, i.toString()],
          schema: childSchema,
          rootSchema: link.rootSchema,
        },
        newValue[i],
        context,
        options,
      );
      changes.push(...nestedChanges);
    }

    // Handle array length changes
    if (Array.isArray(currentValue) && currentValue.length > newValue.length) {
      // We need to add the schema here, since the array may be secret, so the length should be too
      const lub = (link.schema !== undefined)
        ? runtime.cfc.lubSchema(link.schema)
        : undefined;
      // We have to cast these, since the type could be changed to another value
      const childSchema = (lub !== undefined)
        ? { type: "number", ifc: { classification: [lub] } } as JSONSchema
        : { type: "number" } as JSONSchema;
      changes.push({
        location: {
          ...link,
          path: [...link.path, "length"],
          schema: childSchema,
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
    if (!isRecord(currentValue) || isAnyCellLink(currentValue)) {
      changes.push({ location: link, value: {} });
      currentValue = {};
    }

    for (const key in newValue) {
      const childSchema = runtime.cfc.getSchemaAtPath(
        link.schema,
        [key],
        link.rootSchema,
      );
      const nestedChanges = normalizeAndDiff(
        runtime,
        tx,
        { ...link, path: [...link.path, key], schema: childSchema },
        newValue[key],
        context,
        options,
      );
      changes.push(...nestedChanges);
    }

    // Handle removed keys
    for (const key in currentValue) {
      if (!(key in newValue)) {
        changes.push({
          location: { ...link, path: [...link.path, key] },
          value: undefined,
        });
      }
    }

    return changes;
  }

  // When setting array length, also update the removed/added elements.
  if (
    link.path.length > 0 && link.path[link.path.length - 1] === "length"
  ) {
    const maybeCurrentArray = tx.readValueOrThrow({
      ...link,
      path: link.path.slice(0, -1),
    }, options);
    if (Array.isArray(maybeCurrentArray)) {
      const currentLength = maybeCurrentArray.length;
      const newLength = newValue as number;
      if (currentLength !== newLength) {
        changes.push({ location: link, value: newLength });
        for (
          let i = Math.min(currentLength, newLength);
          i < Math.max(currentLength, newLength);
          i++
        ) {
          changes.push({
            location: {
              ...link,
              path: [...link.path.slice(0, -1), i.toString()],
            },
            value: undefined,
          });
        }
        return changes;
      }
    } // else, i.e. parent is not an array: fall through to the primitive case
  }

  // Handle primitive values and other cases (Object.is handles NaN and -0)
  if (!Object.is(currentValue, newValue)) {
    changes.push({ location: link, value: newValue as JSONValue });
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
  tx: IExtendedStorageTransaction,
  changes: ChangeSet,
) {
  for (const change of changes) {
    tx.writeValueOrThrow(change.location, change.value);
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
