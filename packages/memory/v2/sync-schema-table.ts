import type { JSONSchema } from "@commonfabric/api";
import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type {
  ServerMessage,
  SessionEffectMessage,
  SessionSync,
} from "../v2.ts";
import { isPlainObject } from "@commonfabric/utils/types";
import {
  findSyncSchemaRef,
  SYNC_SCHEMA_REF_PREFIX,
} from "./sync-schema-ref.ts";
import { mapLinkSchemas } from "./schema-table-links.ts";

type SchemaTable = Record<string, JSONSchema>;

export type SchemaTableSessionSync = SessionSync & {
  schemaTable?: SchemaTable;
};

type RewriteState = {
  schemas: Map<string, JSONSchema>;
  changed: boolean;
  onSchema?: (schema: JSONSchema) => void;
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
  state.onSchema?.(schemaAndHash.schema);
  if (!state.schemas.has(hash)) {
    state.schemas.set(hash, schemaAndHash.schema);
  }
  return `${SYNC_SCHEMA_REF_PREFIX}${hash}`;
};

const expandSchemaRef = (
  value: unknown,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): JSONSchema | undefined => {
  if (
    typeof value !== "string" ||
    !value.startsWith(SYNC_SCHEMA_REF_PREFIX)
  ) {
    return undefined;
  }
  const hash = value.slice(SYNC_SCHEMA_REF_PREFIX.length);
  if (
    hash.length === 0 || schemas === undefined ||
    !Object.hasOwn(schemas, hash)
  ) {
    throw new Error(`Invalid sync schema table reference: ${value}`);
  }
  const schema = schemas[hash];
  const schemaAndHash = internSchema(schema, true);
  if (schemaAndHash.taggedHashString !== hash) {
    throw new Error(
      `Invalid sync schema table content for reference: ${value}`,
    );
  }
  onSchema?.(schemaAndHash.schema);
  return schemaAndHash.schema;
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
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): unknown => expandSchemaRef(value, schemas, onSchema) ?? value;

const rewriteValue = (value: unknown, state: RewriteState): unknown =>
  mapLinkSchemas(value, (schema) => rewriteSchemaValue(schema, state));

const expandValue = (
  value: unknown,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): unknown =>
  mapLinkSchemas(
    value,
    (schema) => expandSchemaValue(schema, schemas, onSchema),
  );

export const compressSessionSyncSchemas = (
  sync: SessionSync,
  onSchema?: (schema: JSONSchema) => void,
): SessionSync | SchemaTableSessionSync => {
  const state: RewriteState = {
    schemas: new Map(),
    changed: false,
    onSchema,
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
    schemaTable: Object.fromEntries(state.schemas),
  };
};

export const expandSessionSyncSchemas = (
  sync: SessionSync | SchemaTableSessionSync,
  onSchema?: (schema: JSONSchema) => void,
): SessionSync => {
  const schemas = (sync as SchemaTableSessionSync).schemaTable;
  if (schemas === undefined || Object.keys(schemas).length === 0) {
    for (const upsert of sync.upserts) {
      const ref = findSyncSchemaRef(upsert.doc);
      if (ref !== undefined) {
        expandSchemaRef(ref, schemas, onSchema);
      }
    }
    return sync;
  }

  const upserts = sync.upserts.map((upsert) => {
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = expandValue(upsert.doc, schemas, onSchema);
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

const compressResponseSync = (
  message: ServerMessage,
  onSchema?: (schema: JSONSchema) => void,
): ServerMessage => {
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
      sync: compressSessionSyncSchemas(
        sync as unknown as SessionSync,
        onSchema,
      ),
    },
  };
};

const expandResponseSync = (
  message: unknown,
  onSchema?: (schema: JSONSchema) => void,
): unknown => {
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
        onSchema,
      ),
    },
  };
};

export const compressServerMessageSchemas = (
  message: ServerMessage,
  onSchema?: (schema: JSONSchema) => void,
): ServerMessage => {
  if (message.type === "session/effect") {
    return {
      ...message,
      effect: compressSessionSyncSchemas(message.effect, onSchema),
    } as SessionEffectMessage;
  }
  return compressResponseSync(message, onSchema);
};

export const expandServerMessageSchemas = (
  message: unknown,
  onSchema?: (schema: JSONSchema) => void,
): unknown => {
  if (isPlainRecord(message) && message.type === "session/effect") {
    return {
      ...message,
      effect: expandSessionSyncSchemas(
        message.effect as SchemaTableSessionSync,
        onSchema,
      ),
    };
  }
  return expandResponseSync(message, onSchema);
};
