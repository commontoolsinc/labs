import { LINK_V1_TAG } from "@commonfabric/data-model/cell-rep";
import { isPlainObject } from "@commonfabric/utils/types";

export const SYNC_SCHEMA_REF_PREFIX = "schema-ref@2:";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value);

const schemaRefInPayload = (
  payload: Record<string, unknown>,
): string | undefined => {
  const schema = payload.schema;
  return typeof schema === "string" &&
      schema.startsWith(SYNC_SCHEMA_REF_PREFIX)
    ? schema
    : undefined;
};

const pushOwnValuesExcept = (
  pending: unknown[],
  record: Record<string, unknown>,
  skippedKey: string,
): void => {
  for (const key in record) {
    if (key !== skippedKey && Object.hasOwn(record, key)) {
      pending.push(record[key]);
    }
  }
};

/** Finds reserved wire references only in link-payload schema positions. */
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
    if (!isPlainRecord(current)) {
      continue;
    }

    const linkEnvelope = current["/"];
    const linkPayload = isPlainRecord(linkEnvelope)
      ? linkEnvelope[LINK_V1_TAG]
      : undefined;
    const hasLinkPayload = isPlainRecord(linkEnvelope) &&
      isPlainRecord(linkPayload);
    if (hasLinkPayload) {
      const ref = schemaRefInPayload(linkPayload);
      if (ref !== undefined) {
        return ref;
      }
      pushOwnValuesExcept(pending, linkPayload, "schema");
      pushOwnValuesExcept(pending, linkEnvelope, LINK_V1_TAG);
    }

    const legacyAlias = current.$alias;
    const hasLegacyAlias = isPlainRecord(legacyAlias);
    if (hasLegacyAlias) {
      const ref = schemaRefInPayload(legacyAlias);
      if (ref !== undefined) {
        return ref;
      }
      pushOwnValuesExcept(pending, legacyAlias, "schema");
    }

    for (const key in current) {
      if (!Object.hasOwn(current, key)) {
        continue;
      }
      if (
        (key === "/" && hasLinkPayload) ||
        (key === "$alias" && hasLegacyAlias)
      ) {
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
      if (current.startsWith(SYNC_SCHEMA_REF_PREFIX)) {
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
