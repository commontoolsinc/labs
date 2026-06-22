import type { JSONSchema } from "@commonfabric/api";
import { LINK_V1_TAG } from "@commonfabric/data-model/cell-rep";
import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type {
  ServerMessage,
  SessionEffectMessage,
  SessionSync,
} from "../v2.ts";
import { isPlainObject } from "@commonfabric/utils/types";

const SCHEMA_REF_PREFIX = "schema-ref@1:";

export type SchemaTableSessionSync = SessionSync & {
  schemaTable?: JSONSchema[];
};

type RewriteState = {
  schemas: JSONSchema[];
  schemaIndexes: Map<string, number>;
  changed: boolean;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value);

const isCompressibleSchema = (value: unknown): value is JSONSchema =>
  value === true || value === false || isPlainRecord(value);

const schemaRefFor = (
  schema: JSONSchema,
  state: RewriteState,
): string => {
  const schemaAndHash = internSchema(schema, true);
  const hash = schemaAndHash.taggedHashString;
  const existing = state.schemaIndexes.get(hash);
  if (existing !== undefined) {
    return `${SCHEMA_REF_PREFIX}${existing}`;
  }

  const index = state.schemas.length;
  state.schemaIndexes.set(hash, index);
  state.schemas.push(schemaAndHash.schema);
  return `${SCHEMA_REF_PREFIX}${index}`;
};

const expandSchemaRef = (
  value: unknown,
  schemas: readonly JSONSchema[] | undefined,
): JSONSchema | undefined => {
  if (typeof value !== "string" || !value.startsWith(SCHEMA_REF_PREFIX)) {
    return undefined;
  }
  const index = Number(value.slice(SCHEMA_REF_PREFIX.length));
  if (!Number.isInteger(index) || index < 0 || schemas?.[index] === undefined) {
    throw new Error(`Invalid sync schema table reference: ${value}`);
  }
  return internSchema(schemas[index]);
};

const rewriteSchemaValue = (
  value: unknown,
  state: RewriteState,
): unknown => {
  if (isCompressibleSchema(value)) {
    state.changed = true;
    return schemaRefFor(value, state);
  }
  return value;
};

const expandSchemaValue = (
  value: unknown,
  schemas: readonly JSONSchema[] | undefined,
): unknown => expandSchemaRef(value, schemas) ?? value;

const rewriteLinkPayload = (
  payload: Record<string, unknown>,
  state: RewriteState,
): Record<string, unknown> => {
  if (!Object.hasOwn(payload, "schema")) {
    return payload;
  }
  const schema = rewriteSchemaValue(payload.schema, state);
  return schema === payload.schema ? payload : { ...payload, schema };
};

const expandLinkPayload = (
  payload: Record<string, unknown>,
  schemas: readonly JSONSchema[] | undefined,
): Record<string, unknown> => {
  if (!Object.hasOwn(payload, "schema")) {
    return payload;
  }
  const schema = expandSchemaValue(payload.schema, schemas);
  return schema === payload.schema ? payload : { ...payload, schema };
};

const rewriteValue = (value: unknown, state: RewriteState): unknown => {
  if (Array.isArray(value)) {
    let changed = false;
    const rewritten = value.map((item) => {
      const next = rewriteValue(item, state);
      changed ||= next !== item;
      return next;
    });
    return changed ? rewritten : value;
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const linkEnvelope = value["/"];
  if (isPlainRecord(linkEnvelope)) {
    const payload = linkEnvelope[LINK_V1_TAG];
    if (isPlainRecord(payload)) {
      const nextPayload = rewriteLinkPayload(payload, state);
      if (nextPayload !== payload) {
        return {
          ...value,
          "/": {
            ...linkEnvelope,
            [LINK_V1_TAG]: nextPayload,
          },
        };
      }
    }
  }

  const legacyAlias = value.$alias;
  if (isPlainRecord(legacyAlias)) {
    const nextAlias = rewriteLinkPayload(legacyAlias, state);
    if (nextAlias !== legacyAlias) {
      return { ...value, $alias: nextAlias };
    }
  }

  let changed = false;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = rewriteValue(child, state);
    changed ||= next !== child;
    rewritten[key] = next;
  }
  return changed ? rewritten : value;
};

const expandValue = (
  value: unknown,
  schemas: readonly JSONSchema[] | undefined,
): unknown => {
  if (Array.isArray(value)) {
    let changed = false;
    const expanded = value.map((item) => {
      const next = expandValue(item, schemas);
      changed ||= next !== item;
      return next;
    });
    return changed ? expanded : value;
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const linkEnvelope = value["/"];
  if (isPlainRecord(linkEnvelope)) {
    const payload = linkEnvelope[LINK_V1_TAG];
    if (isPlainRecord(payload)) {
      const nextPayload = expandLinkPayload(payload, schemas);
      if (nextPayload !== payload) {
        return {
          ...value,
          "/": {
            ...linkEnvelope,
            [LINK_V1_TAG]: nextPayload,
          },
        };
      }
    }
  }

  const legacyAlias = value.$alias;
  if (isPlainRecord(legacyAlias)) {
    const nextAlias = expandLinkPayload(legacyAlias, schemas);
    if (nextAlias !== legacyAlias) {
      return { ...value, $alias: nextAlias };
    }
  }

  let changed = false;
  const expanded: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = expandValue(child, schemas);
    changed ||= next !== child;
    expanded[key] = next;
  }
  return changed ? expanded : value;
};

export const compressSessionSyncSchemas = (
  sync: SessionSync,
): SessionSync | SchemaTableSessionSync => {
  const state: RewriteState = {
    schemas: [],
    schemaIndexes: new Map(),
    changed: false,
  };
  const upserts = sync.upserts.map((upsert) => {
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = rewriteValue(upsert.doc, state);
    return doc === upsert.doc ? upsert : {
      ...upsert,
      doc: doc as typeof upsert.doc,
    };
  });

  if (!state.changed) {
    return sync;
  }

  return {
    ...sync,
    upserts,
    schemaTable: state.schemas,
  };
};

export const expandSessionSyncSchemas = (
  sync: SessionSync | SchemaTableSessionSync,
): SessionSync => {
  const schemas = (sync as SchemaTableSessionSync).schemaTable;
  if (schemas === undefined || schemas.length === 0) {
    return sync;
  }

  const upserts = sync.upserts.map((upsert) => {
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = expandValue(upsert.doc, schemas);
    return doc === upsert.doc ? upsert : {
      ...upsert,
      doc: doc as typeof upsert.doc,
    };
  });

  const withExpandedUpserts: SchemaTableSessionSync = {
    ...sync,
    upserts,
  };
  const { schemaTable: _schemaTable, ...expanded } = withExpandedUpserts;
  return deepFreeze(expanded as SessionSync);
};

const compressResponseSync = (message: ServerMessage): ServerMessage => {
  if (message.type !== "response" || message.ok === undefined) {
    return message;
  }
  if (!isPlainRecord(message.ok)) {
    return message;
  }
  const sync = message.ok.sync;
  if (!isPlainRecord(sync) || sync.type !== "sync") {
    return message;
  }

  return {
    ...message,
    ok: {
      ...message.ok,
      sync: compressSessionSyncSchemas(sync as unknown as SessionSync),
    },
  };
};

const expandResponseSync = (message: unknown): unknown => {
  if (!isPlainRecord(message) || message.type !== "response") {
    return message;
  }
  if (!isPlainRecord(message.ok)) {
    return message;
  }
  const sync = message.ok.sync;
  if (!isPlainRecord(sync) || sync.type !== "sync") {
    return message;
  }

  return {
    ...message,
    ok: {
      ...message.ok,
      sync: expandSessionSyncSchemas(
        sync as unknown as SchemaTableSessionSync,
      ),
    },
  };
};

export const compressServerMessageSchemas = (
  message: ServerMessage,
): ServerMessage => {
  if (message.type === "session/effect") {
    return {
      ...message,
      effect: compressSessionSyncSchemas(message.effect),
    } as SessionEffectMessage;
  }
  return compressResponseSync(message);
};

export const expandServerMessageSchemas = (message: unknown): unknown => {
  if (isPlainRecord(message) && message.type === "session/effect") {
    return {
      ...message,
      effect: expandSessionSyncSchemas(
        message.effect as SchemaTableSessionSync,
      ),
    };
  }
  return expandResponseSync(message);
};
