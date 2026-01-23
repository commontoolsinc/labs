import { isRecord } from "@commontools/utils/types";
import { isArrayIndexPropertyName, toStorableValue } from "./value-codec.ts";
import { getLogger } from "@commontools/utils/logger";
import { ID, ID_FIELD, type JSONSchema } from "./builder/types.ts";
import { type StorableValue } from "./interface.ts";
import { createRef } from "./create-ref.ts";
import { CellImpl, isCell } from "./cell.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areLinksSame,
  areMaybeLinkAndNormalizedLinkSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  findAndInlineDataURILinks,
  isCellLink,
  isPrimitiveCellLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { isCellResultForDereferencing } from "./query-result-proxy.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
  type JSONValue,
} from "./storage/interface.ts";
import { type Runtime } from "./runtime.ts";
import { toURI } from "./uri-utils.ts";
import { markReadAsPotentialWrite } from "./scheduler.ts";

const diffLogger = getLogger("normalizeAndDiff", {
  enabled: false,
  level: "debug",
});

// Sentinel value to distinguish "no precomputed value" from "precomputed value is undefined"
const NO_PRECOMPUTED = Symbol("no-precomputed");

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
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: IReadOptions,
): boolean {
  const readOptions: IReadOptions = {
    ...options,
    meta: { ...options?.meta, ...markReadAsPotentialWrite },
  };
  const changes = normalizeAndDiff(
    runtime,
    tx,
    link,
    newValue,
    context,
    readOptions,
  );
  diffLogger.debug(
    "diff",
    () => `[diffAndUpdate] changes: ${JSON.stringify(changes)}`,
  );
  applyChangeSet(tx, changes);
  return changes.length > 0;
}

export type ChangeSet = {
  location: NormalizedFullLink;
  value: StorableValue;
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
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: IReadOptions,
  seen: Map<any, NormalizedFullLink> = new Map(),
  precomputedCurrent: unknown = NO_PRECOMPUTED,
): ChangeSet {
  const changes: ChangeSet = [];

  // Log entry with value type and symbol presence
  const valueType = Array.isArray(newValue) ? "array" : typeof newValue;
  const pathStr = link.path.join(".");
  diffLogger.debug(
    "diff",
    () =>
      `[DIFF_ENTER] path=${pathStr} type=${valueType} newValue=${
        JSON.stringify(newValue as any)
      }`,
  );

  // When detecting a circular reference on JS objects, turn it into a cell,
  // which below will be turned into a relative link.
  if (seen.has(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[SEEN_CHECK] Already seen object at path=${pathStr}, converting to cell`,
    );
    newValue = new CellImpl(runtime, tx, seen.get(newValue)!);
  }

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
    diffLogger.debug(
      "diff",
      () => `[BRANCH_ID_FIELD] Processing ID_FIELD redirect at path=${pathStr}`,
    );
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
          if (isCellLink(v)) {
            const sibling = parseLink(v, base);
            const siblingId = tx.readValueOrThrow({
              ...sibling,
              path: [...sibling.path, fieldName as string],
            }, options);
            if (siblingId === id) {
              // We found a sibling with the same id, so ...
              return [
                // ... reuse the existing document
                ...normalizeAndDiff(
                  runtime,
                  tx,
                  link,
                  v,
                  context,
                  options,
                  seen,
                ),
                // ... and update it to the new value
                ...normalizeAndDiff(
                  runtime,
                  tx,
                  sibling,
                  rest,
                  context,
                  options,
                  seen,
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
  if (isCellResultForDereferencing(newValue)) {
    const parsedLink = parseLink(newValue);
    const sigilLink = createSigilLinkFromParsedLink(parsedLink);
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_QUERY_RESULT] Converted query result to sigil link at path=${pathStr} link=${sigilLink} parsedLink=${parsedLink}`,
    );
    newValue = sigilLink;
  }

  // Track whether this link originates from a Cell value (either a cycle we
  // wrapped into a CellImpl above, or a user-supplied Cell). For Cell-origin
  // links we preserve the link (do NOT collapse). For links created via
  // query-result dereferencing (non-Cell), we may collapse immediate-parent
  // self-links.
  let linkOriginFromCell = false;
  if (isCell(newValue)) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_CELL] Converting cell to link at path=${pathStr}`,
    );
    linkOriginFromCell = true;
    newValue = newValue.getAsLink();
  }

  // Check for links that are data: URIs and inline them, by calling
  // normalizeAndDiff on the contents of the link.
  if (
    isCellLink(newValue) && parseLink(newValue, link).id?.startsWith("data:")
  ) {
    return normalizeAndDiff(
      runtime,
      tx,
      link,
      findAndInlineDataURILinks(newValue),
      context,
      options,
      seen,
    );
  }

  // If we're about to create a reference to ourselves, no-op
  if (areMaybeLinkAndNormalizedLinkSame(newValue, link)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_SELF_REF] Self-reference detected, no-op at path=${pathStr}`,
    );
    return [];
  }

  // Get current value to compare against (use precomputed if available)
  let currentValue = precomputedCurrent === NO_PRECOMPUTED
    ? tx.readValueOrThrow(link, options)
    : precomputedCurrent;

  // A new alias can overwrite a previous alias. No-op if the same.
  if (isWriteRedirectLink(newValue)) {
    if (
      isWriteRedirectLink(currentValue) &&
      areNormalizedLinksSame(parseLink(currentValue, link), link)
    ) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_WRITE_REDIRECT] Same redirect, no-op at path=${pathStr}`,
      );
      return [];
    } else {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_WRITE_REDIRECT] Different redirect, updating at path=${pathStr}`,
      );
      changes.push({ location: link, value: newValue as StorableValue });
      return changes;
    }
  }

  // Handle alias in current value (at this point: if newValue is not an alias)
  if (isWriteRedirectLink(currentValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_CURRENT_ALIAS] Following current value alias at path=${pathStr}`,
    );
    // Log reads of the alias, so that changing aliases cause refreshes
    const redirectLink = resolveLink(
      runtime,
      tx,
      parseLink(currentValue, link),
      "writeRedirect",
    );
    return normalizeAndDiff(
      runtime,
      tx,
      redirectLink,
      newValue,
      context,
      options,
      seen,
    );
  }

  if (isPrimitiveCellLink(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_CELL_LINK] Processing cell link at path=${pathStr} link=${
          JSON.stringify(newValue as any)
        }`,
    );
    const parsedLink = parseLink(newValue, link);

    // Collapse same-document self/parent links created by query-result dereferencing.
    // Example: "internal.__#1.next" -> "internal.__#1". Writing that link would
    // create a tight self-loop, so we instead embed the target's current value
    // (a plain JSON snapshot). Do not collapse when the link came from converting
    // a seen cycle to a Cell, and only collapse when the target is the immediate
    // parent path.
    if (!linkOriginFromCell && isImmediateParent(parsedLink, link)) {
      diffLogger.debug(
        "diff",
        () =>
          `[CELL_LINK_COLLAPSE] Same-doc ancestor/self link detected at path=${pathStr} -> embedding snapshot from ${
            parsedLink.path.join(".")
          }`,
      );
      const snapshot = tx.readValueOrThrow(
        parsedLink,
        options,
      ) as unknown;
      return normalizeAndDiff(
        runtime,
        tx,
        link,
        snapshot,
        context,
        options,
        seen,
      );
    }
    if (
      isPrimitiveCellLink(currentValue) &&
      areLinksSame(newValue, currentValue, link)
    ) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_CELL_LINK] Same cell link, no-op at path=${pathStr}`,
      );
      return [];
    } else {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_CELL_LINK] Different cell link, updating at path=${pathStr}`,
      );
      return [
        // TODO(seefeld): Normalize the link to a sigil link?
        { location: link, value: newValue as StorableValue },
      ];
    }
  }

  // Handle ID-based object (convert to entity)
  if (isRecord(newValue) && newValue[ID] !== undefined) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_ID_OBJECT] Processing ID-based object at path=${pathStr}`,
    );
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

    seen.set(newValue, newEntryLink);

    return [
      // If it wasn't already, set the current value to be a doc link to this doc
      ...normalizeAndDiff(
        runtime,
        tx,
        link,
        createSigilLinkFromParsedLink(newEntryLink, { base: link }),
        context,
        options,
        seen,
      ),
      // And see whether the value of the document itself changed
      ...normalizeAndDiff(
        runtime,
        tx,
        newEntryLink,
        rest,
        context,
        options,
        seen,
      ),
    ];
  }

  // Convert the (top level of) the value to something JSON-encodable if not
  // already JSON-encodable, or throw if it's neither already valid nor
  // convertible.
  const storableValue = toStorableValue(newValue);
  if (storableValue !== newValue) {
    diffLogger.debug(
      "diff",
      () =>
        `[TO_STORABLE_VALUE] Converted ${typeof newValue} at path=${pathStr}`,
    );
    newValue = storableValue;
  }

  // Handle arrays
  if (Array.isArray(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_ARRAY] Processing array at path=${pathStr} length=${newValue.length}`,
    );
    // If the current value is not an array, set it to an empty array
    if (!Array.isArray(currentValue)) {
      changes.push({ location: link, value: [] });
    }

    // Have to set this before recursing!
    seen.set(newValue, link);

    // Get current array for precomputing child values (if it was an array)
    const currentArray = Array.isArray(currentValue) ? currentValue : undefined;

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
        seen,
        currentArray?.[i],
      );
      changes.push(...nestedChanges);
    }

    // Handle array length changes
    if (Array.isArray(currentValue) && currentValue.length != newValue.length) {
      // We need to add the schema here, since the array may be secret, so the length should be too
      const lub = (link.schema !== undefined)
        ? runtime.cfc.lubSchema(link.schema, link.rootSchema)
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
    diffLogger.debug(
      "diff",
      () => `[BRANCH_OBJECT] Processing object at path=${pathStr}`,
    );
    // If the current value is not a (regular) object, set it to an empty object
    // Note that the alias case is handled above
    if (!isRecord(currentValue) || isPrimitiveCellLink(currentValue)) {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_OBJECT] Current value is not a record or cell link, setting to empty object at path=${pathStr}`,
      );
      changes.push({ location: link, value: {} });
      currentValue = {};
    }

    // Have to set this before recursing!
    seen.set(newValue, link);

    // At this point currentValue is guaranteed to be a record
    const currentRecord = currentValue as Record<string, unknown>;

    for (const key in newValue) {
      diffLogger.debug("diff", () => {
        const childPath = [...link.path, key].join(".");
        return `[DIFF_RECURSE] Recursing into key='${key}' childPath=${childPath}`;
      });

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
        seen,
        currentRecord[key],
      );
      changes.push(...nestedChanges);
    }

    // Handle removed keys
    for (const key in currentRecord) {
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
    changes.push({ location: link, value: newValue as StorableValue });
  }

  return changes;
}

/**
 * Checks if a value contains data at a given path.
 * Returns true if the path exists in the value (even if the value at that path is undefined).
 */
function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return true;

  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }

  const [first, ...rest] = path;

  if (Array.isArray(value)) {
    // Special case: "length" is always present on arrays
    if (first === "length" && rest.length === 0) return true;
    // Only valid array index strings can access array elements
    if (!isArrayIndexPropertyName(first)) return false;
    // Access with string key works for arrays (array["1"] === array[1]).
    // JSON arrays can't be sparse or contain `undefined`, so `undefined`
    // means the index is out of range.
    const element = (value as unknown as Record<string, unknown>)[first];
    return element !== undefined && hasPath(element, rest);
  }

  const obj = value as Record<string, unknown>;
  if (!(first in obj)) return false;
  return hasPath(obj[first], rest);
}

/**
 * Compacts a ChangeSet by removing redundant child path changes when a
 * parent path change already includes that data.
 *
 * This optimization reduces the number of writes when setting nested structures.
 * For example, if we set `foo = {a: 1, b: 2}` and also set `foo/a = 1`,
 * the child write is redundant since the parent already contains it.
 *
 * Key rules:
 * - Empty objects `{}` or arrays `[]` do NOT subsume children (children populate them)
 * - Parent deletions (`value: undefined`) DO subsume child changes
 * - Parent must actually CONTAIN the child's path for subsumption to occur
 *
 * @param changes - The original change set
 * @returns A compacted change set with redundant child paths removed
 */
export function compactChangeSet(changes: ChangeSet): ChangeSet {
  if (changes.length <= 1) return changes;

  // Group by document using safe separator (JSON.stringify avoids key collisions)
  const byDocument = new Map<string, ChangeSet>();
  for (const change of changes) {
    const key = JSON.stringify([
      change.location.space,
      change.location.id,
      change.location.type,
    ]);
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key)!.push(change);
  }

  const result: ChangeSet = [];
  for (const docChanges of byDocument.values()) {
    // Sort by path length (shortest first - parents before children)
    const sorted = docChanges.toSorted(
      (a, b) => a.location.path.length - b.location.path.length,
    );

    // Track parent paths that can subsume children
    // Empty {} or [] don't subsume - children populate them!
    const subsumingPaths: Array<{ path: readonly string[]; value: unknown }> =
      [];

    for (const change of sorted) {
      const path = change.location.path;

      // Check if subsumed by a parent with actual content
      const isSubsumed = subsumingPaths.some((parent) => {
        if (parent.path.length >= path.length) return false;
        if (!parent.path.every((seg, i) => seg === path[i])) return false;

        // Parent path is prefix - check if parent VALUE contains this child's path
        const parentVal = parent.value;
        if (parentVal === null || parentVal === undefined) return false;
        if (typeof parentVal !== "object") return false;

        // Calculate the relative path from parent to child
        const relativePath = path.slice(parent.path.length);

        // Only subsume if parent's value actually contains data at the child's relative path
        return hasPath(parentVal, relativePath);
      });

      // Also check: is this child subsumed by a DELETION of parent?
      const isDeletedByParent = subsumingPaths.some((parent) => {
        if (parent.path.length >= path.length) return false;
        if (!parent.path.every((seg, i) => seg === path[i])) return false;
        return parent.value === undefined; // Parent deletion subsumes child
      });

      if (!isSubsumed && !isDeletedByParent) {
        result.push(change);
        // Track this path for potential child subsumption
        subsumingPaths.push({ path, value: change.value });
      }
    }
  }

  diffLogger.debug(
    "compact",
    () =>
      `[compactChangeSet] Compacted ${changes.length} changes to ${result.length}`,
  );

  return result;
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
  // CT-1123: Removed compactChangeSet - structural sharing makes redundant writes
  // cheap (O(path_depth) with noop detection), while compaction added O(N²) overhead.
  // Benchmarks showed 2.5-4.4x slowdown with compactChangeSet enabled.
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

    if (isRecord(obj) && !isCell(obj) && !isPrimitiveCellLink(obj)) {
      Object.values(obj).forEach((v) => traverse(v));
    }
  }

  traverse(obj);
}

/**
 * Returns true if `target` is the immediate parent of `base` in the same document.
 *
 * Example:
 * - base.path = ["internal", "__#1", "next"]
 * - target.path = ["internal", "__#1"]
 *
 * This is used to decide when to collapse a self/parent link that would create
 * a tight self-loop (e.g., obj.next -> obj) while allowing references to
 * higher ancestors (like an item's `items` pointing to its containing array).
 */
function isImmediateParent(
  target: NormalizedFullLink,
  base: NormalizedFullLink,
): boolean {
  return (
    target.id === base.id &&
    target.space === base.space &&
    target.path.length === base.path.length - 1 &&
    target.path.every((seg, i) => seg === base.path[i])
  );
}
