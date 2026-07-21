import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { isPlainObject } from "@commonfabric/utils/types";
import { REQUEST_SCHEMA_CAS_REF_PREFIX } from "./schema-table-links.ts";

export const SYNC_SCHEMA_REF_PREFIX = "schema-ref@2:";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value);

const isReservedSchemaRef = (value: string): boolean =>
  value.startsWith(SYNC_SCHEMA_REF_PREFIX) ||
  value.startsWith(REQUEST_SCHEMA_CAS_REF_PREFIX);

/**
 * Whether serialized text contains a reserved reference prefix anywhere.
 * Serializations of documents and patches embed every string value they
 * carry verbatim, so a negative answer proves the serialized value cannot
 * introduce a reserved reference — the cheap gate in front of the deep
 * walks below.
 */
export const containsReservedSchemaRefSubstring = (value: string): boolean =>
  value.includes(SYNC_SCHEMA_REF_PREFIX) ||
  value.includes(REQUEST_SCHEMA_CAS_REF_PREFIX);

const schemaRefIn = (
  payload: Record<string, unknown>,
): string | undefined => {
  const schema = payload.schema;
  return typeof schema === "string" && isReservedSchemaRef(schema)
    ? schema
    : undefined;
};

/**
 * Finds reserved wire references only in link-payload and legacy `$alias`
 * schema positions.
 *
 * Link recognition goes through the `cell-rep` chokepoint ({@link isLinkRef}
 * / {@link linkRefPayload}), covering both `modernCellRep` regimes — legacy
 * envelope or `FabricLink` instance. The `$alias` form predates the
 * chokepoint and is never regime-dispatched, so it is recognized locally.
 */
export const findSyncSchemaRef = (value: unknown): string | undefined => {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        pending.push(current[index]);
      }
      continue;
    }

    if (isLinkRef(current)) {
      const payload = linkRefPayload(current) as Record<string, unknown>;
      const ref = schemaRefIn(payload);
      if (ref !== undefined) {
        return ref;
      }
      for (const key in payload) {
        if (key !== "schema" && Object.hasOwn(payload, key)) {
          pending.push(payload[key]);
        }
      }
      continue;
    }

    if (!isPlainRecord(current)) {
      continue;
    }

    const legacyAlias = current.$alias;
    const hasLegacyAlias = isPlainRecord(legacyAlias);
    if (hasLegacyAlias) {
      const ref = schemaRefIn(legacyAlias);
      if (ref !== undefined) {
        return ref;
      }
      for (const key in legacyAlias) {
        if (key !== "schema" && Object.hasOwn(legacyAlias, key)) {
          pending.push(legacyAlias[key]);
        }
      }
    }

    for (const key in current) {
      if (!Object.hasOwn(current, key)) {
        continue;
      }
      if (key === "$alias" && hasLegacyAlias) {
        continue;
      }
      pending.push(current[key]);
    }
  }

  return undefined;
};

/** Checks arbitrary input for a string that could introduce a wire reference. */
export const containsSyncSchemaRefString = (value: unknown): boolean => {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (isReservedSchemaRef(current)) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        pending.push(current[index]);
      }
      continue;
    }
    if (isLinkRef(current)) {
      // A FabricLink's payload is not reachable by plain-record iteration.
      pending.push(linkRefPayload(current));
      continue;
    }
    if (!isPlainRecord(current)) {
      continue;
    }
    for (const key in current) {
      if (Object.hasOwn(current, key)) {
        pending.push(current[key]);
      }
    }
  }

  return false;
};
