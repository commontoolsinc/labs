/** Validates stored arguments without treating unreadable links as invalid values. */

import type { FabricValue } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import { validateSchemaValue } from "./cfc/schema-sanitization.ts";
import {
  type CellLink,
  isCellLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import {
  mergeSchemaDefaults,
  schemaAcceptsOpaqueCellValue,
} from "./runner-utils.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
  toThrowable,
} from "./storage/interface.ts";

// An unreadable stored link has a value owned elsewhere. Its type is checked
// when reactive reads materialize it, rather than against a replica's absence.
const UNRESOLVED_LINK_PLACEHOLDER = Object.freeze({
  "unresolved cell link": true,
});

const acceptsOpaqueCellOrUnresolvedLink = (
  value: unknown,
  schema: JSONSchema,
): boolean =>
  value === UNRESOLVED_LINK_PLACEHOLDER ||
  schemaAcceptsOpaqueCellValue(value, schema);

const READ_NON_RECURSIVE: IReadOptions = { nonRecursive: true };

/**
 * Reads the raw endpoint of a stored link chain without recursively loading it.
 * An absent document, missing value, non-object path, or cycle returns undefined;
 * operational storage errors propagate. Mid-path links carry the remaining path
 * to their targets rather than traversing the link envelope as data.
 *
 * `chain` tracks the current descent. Entries added by this call are removed on
 * every exit, so sibling references to the same document do not look cyclic.
 * Exported for direct cycle tests because materialization can reject cycles
 * before validation reaches this walk.
 */
export function readStoredLinkChainRaw(
  tx: IExtendedStorageTransaction,
  startLink: NormalizedFullLink,
  chain: Set<string>,
): { value: unknown; base: NormalizedFullLink } {
  const added: string[] = [];
  const follow = (
    value: CellLink,
    base: NormalizedFullLink,
    rest: string[],
  ) => {
    const next = parseLink(value, base);
    const path = [...next.path, ...rest];
    const key = JSON.stringify([next.space, next.id, next.scope, path]);
    if (chain.has(key)) return undefined;
    chain.add(key);
    added.push(key);
    return { ...next, path };
  };
  try {
    let link = startLink;
    while (true) {
      const { ok, error } = tx.read(
        {
          space: link.space,
          id: link.id,
          scope: link.scope,
          type: "application/json",
          path: ["value"],
        },
        READ_NON_RECURSIVE,
      );
      if (error !== undefined) {
        // The same line readOrThrow draws: an absent document or a path
        // through a primitive reads as no value here, and every other
        // failure — a dead transaction, malformed storage — surfaces.
        if (
          error.name !== "NotFoundError" && error.name !== "TypeMismatchError"
        ) {
          throw toThrowable(error);
        }
        return { value: undefined, base: link };
      }
      if (ok.value === undefined) {
        return { value: undefined, base: link };
      }
      let value: unknown = ok.value;
      const path = [...link.path] as string[];
      let followed: NormalizedFullLink | undefined;
      while (path.length > 0) {
        if (isCellLink(value)) {
          // A link met mid-path: the rest of the path applies at its target.
          followed = follow(value, link, path);
          if (followed === undefined) return { value: undefined, base: link };
          break;
        }
        if (!isObjectOrArray(value)) {
          return { value: undefined, base: link };
        }
        value = (value as Record<string, unknown>)[path.shift()!];
      }
      if (followed === undefined && isCellLink(value)) {
        followed = follow(value, link, []);
        if (followed === undefined) return { value: undefined, base: link };
      }
      if (followed !== undefined) {
        link = followed;
        continue;
      }
      return { value, base: link };
    }
  } finally {
    for (const key of added) chain.delete(key);
  }
}

/**
 * Replaces undefined materializations reached through stored links with opaque
 * placeholders. Readable wrong-typed values and inline undefined values remain
 * unchanged. The walk follows stored links at every depth, including across
 * documents and spaces, without loading missing targets.
 */
function overlayUnreadableLinkPlaceholders(
  tx: IExtendedStorageTransaction,
  base: NormalizedFullLink,
  raw: unknown,
  materialized: unknown,
  chain: Set<string>,
): unknown {
  if (isCellLink(raw)) {
    if (materialized === undefined) return UNRESOLVED_LINK_PLACEHOLDER;
    const link = parseLink(raw, base);
    const key = JSON.stringify([link.space, link.id, link.scope, link.path]);
    if (chain.has(key)) return materialized;
    chain.add(key);
    const reading = readStoredLinkChainRaw(tx, link, chain);
    const result = reading.value === undefined
      ? materialized
      : overlayUnreadableLinkPlaceholders(
        tx,
        reading.base,
        reading.value,
        materialized,
        chain,
      );
    chain.delete(key);
    return result;
  }
  if (Array.isArray(raw) && Array.isArray(materialized)) {
    let result: unknown[] | undefined;
    for (let i = 0; i < raw.length; i++) {
      const child = overlayUnreadableLinkPlaceholders(
        tx,
        base,
        raw[i],
        materialized[i],
        chain,
      );
      if (child !== materialized[i]) {
        result ??= materialized.slice();
        result[i] = child;
      }
    }
    return result ?? materialized;
  }
  if (isObjectOrArray(raw) && isObjectOrArray(materialized)) {
    let result: Record<string, unknown> | undefined;
    for (const [key, rawChild] of Object.entries(raw)) {
      const child = overlayUnreadableLinkPlaceholders(
        tx,
        base,
        rawChild,
        (materialized as Record<string, unknown>)[key],
        chain,
      );
      if (child !== (materialized as Record<string, unknown>)[key]) {
        result ??= { ...(materialized as Record<string, unknown>) };
        result[key] = child;
      }
    }
    return result ?? materialized;
  }
  return materialized;
}

/**
 * Returns a stored argument's schema mismatch, deferring unreadable linked slots.
 * Source preflight and runtime setup use the same defaults and absence rules.
 * The caller supplies the transaction so staged writes and read-only checks
 * validate the storage version they actually act on.
 */
export function storedArgumentValidationIssue(
  argumentCell: Cell<unknown>,
  argumentSchema: JSONSchema,
  defaults: FabricValue,
  tx: IExtendedStorageTransaction,
): string | undefined {
  const argumentLink = argumentCell.getAsNormalizedFullLink();
  const materializedArgument = argumentCell.asSchema(undefined).withTx(tx)
    .get();
  const validationArgument: unknown = mergeSchemaDefaults(
    materializedArgument,
    defaults,
    argumentSchema,
    { mergeMaterializedLinks: true },
  );
  const validationOptions = {
    acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
    // A stored optional key holding undefined carries no supplied value.
    // Keep this relaxation local to argument validation, not result writes.
    optionalUndefinedIsAbsent: true,
  };
  let validationFailure = validateSchemaValue(
    argumentSchema,
    validationArgument,
    argumentSchema,
    validationOptions,
  );
  if (validationFailure !== undefined) {
    // Only undefined linked slots can change verdict. Defer those slots to
    // reactive reads, avoiding a second graph walk on the valid common path.
    validationFailure = validateSchemaValue(
      argumentSchema,
      overlayUnreadableLinkPlaceholders(
        tx,
        argumentLink,
        argumentCell.withTx(tx).getRaw({ meta: ignoreReadForScheduling }),
        validationArgument,
        new Set(),
      ),
      argumentSchema,
      validationOptions,
    );
  }
  return validationFailure;
}
