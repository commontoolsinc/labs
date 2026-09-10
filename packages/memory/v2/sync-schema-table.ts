import type { FabricValue, JSONSchema } from "@commonfabric/api";
import { deepFreeze } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import { isPlainObject } from "@commonfabric/utils/types";

import type {
  ServerMessage,
  SessionEffectMessage,
  SessionSync,
} from "../v2.ts";
import { encodeMemoryBoundary } from "../v2.ts";
import { mapLinkSchemas } from "./schema-table-links.ts";
import {
  findSyncSchemaRef,
  SYNC_SCHEMA_REF_PREFIX,
} from "./sync-schema-ref.ts";

type SchemaTable = Record<string, JSONSchema>;

/** A wire upsert whose document-root schema is held in the sync's table. */
export type SchemaTableUpsert = SessionSync["upserts"][number] & {
  /** Tagged table hash, removed before the upsert reaches the session cache. */
  documentSchemaRef?: string;
};

/** Wire sync carrying schema bodies shared by its link and metadata references. */
export type SchemaTableSessionSync = Omit<SessionSync, "upserts"> & {
  /** Schema bodies verified against their tagged hashes during expansion. */
  schemaTable?: SchemaTable;
  /** Document updates with optional frame-local metadata references. */
  upserts: SchemaTableUpsert[];
};

type RewriteState = {
  schemas: Map<string, JSONSchema>;
  changed: boolean;
  onSchema?: (schema: JSONSchema) => void;
};

/**
 * A reference-only schema position: `{ "$ref": "cid:…" }` and nothing else,
 * pointing at a content-addressed schema document
 * (`docs/specs/content-addressed-schemas.md`). Already smaller than a table
 * ref, so compressing it would grow the frame; the schema body travels once
 * as the referenced document itself.
 */
const isSchemaDocumentRefOnly = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "$ref" &&
    typeof value.$ref === "string" && value.$ref.startsWith("cid:");
};

const isCompressibleSchema = (value: unknown): value is JSONSchema =>
  (value === true || value === false || isPlainObject(value)) &&
  !isSchemaDocumentRefOnly(value);

const schemaRefFor = (
  schema: JSONSchema,
  state: RewriteState,
): string => {
  const schemaAndHash = internSchema(schema, true);
  const hash = schemaAndHash.taggedHashString;
  if (!state.schemas.has(hash)) {
    state.schemas.set(hash, schemaAndHash.schema);
    state.onSchema?.(schemaAndHash.schema);
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
  value: FabricValue,
  state: RewriteState,
): FabricValue => {
  if (isCompressibleSchema(value)) {
    state.changed = true;
    return schemaRefFor(value, state);
  }
  return value;
};

const expandSchemaValue = (
  value: FabricValue,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): FabricValue => expandSchemaRef(value, schemas, onSchema) ?? value;

const rewriteValue = (value: FabricValue, state: RewriteState): FabricValue =>
  mapLinkSchemas(value, (schema) => rewriteSchemaValue(schema, state));

const expandValue = (
  value: FabricValue,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): FabricValue =>
  mapLinkSchemas(
    value,
    (schema) => expandSchemaValue(schema, schemas, onSchema),
  );

/**
 * Moves repeated document-root schemas into the existing frame-local table.
 * References live on the upsert envelope, so schema-shaped application data
 * never acquires another interpreted position. Small and unique schemas stay
 * inline to keep the table from increasing their encoded size.
 */
const compressDocumentSchemas = (
  upserts: SessionSync["upserts"],
  state: RewriteState,
): SchemaTableUpsert[] => {
  const hashes = new Map<number, string>();
  const counts = new Map<string, number>();
  const schemas = new Map<string, JSONSchema>();
  for (let index = 0; index < upserts.length; index++) {
    const schema = upserts[index].doc?.schema;
    if (!isCompressibleSchema(schema) || typeof schema === "boolean") {
      continue;
    }
    const hash = internSchema(schema, true).taggedHashString;
    hashes.set(index, hash);
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
    schemas.set(hash, schema);
  }
  const repeated = new Set(
    [...schemas].filter(([hash, schema]) =>
      counts.get(hash)! >= 2 && encodeMemoryBoundary(schema).length >= 256
    ).map(([hash]) => hash),
  );
  return upserts.map((upsert, index) => {
    const hash = hashes.get(index);
    if (hash === undefined || !repeated.has(hash)) return upsert;
    const { schema, ...doc } = upsert.doc!;
    schemaRefFor(schema as JSONSchema, state);
    state.changed = true;
    return { ...upsert, doc, documentSchemaRef: hash };
  });
};

/**
 * Restores document metadata before link-schema expansion sees its contents.
 * A malformed envelope must fail before any partial document reaches a cache.
 */
const expandDocumentSchema = (
  upsert: SchemaTableUpsert,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): SessionSync["upserts"][number] => {
  if (!Object.hasOwn(upsert, "documentSchemaRef")) return upsert;
  if (
    typeof upsert.documentSchemaRef !== "string" ||
    !isPlainObject(upsert.doc) || Object.hasOwn(upsert.doc, "schema")
  ) {
    throw new Error("Invalid document schema table reference");
  }
  const schema = expandSchemaRef(
    `${SYNC_SCHEMA_REF_PREFIX}${upsert.documentSchemaRef}`,
    schemas,
    onSchema,
  );
  const { documentSchemaRef: _reference, ...rest } = upsert;
  return { ...rest, doc: { ...upsert.doc, schema } };
};

/** Finds document-schema references only on sync upsert envelopes. */
export const hasDocumentSchemaReferences = (message: unknown): boolean => {
  if (!isPlainObject(message)) return false;
  const sync = message.type === "session/effect"
    ? message.effect
    : message.type === "response" && isPlainObject(message.ok)
    ? message.ok.sync
    : undefined;
  return isPlainObject(sync) && sync.type === "sync" &&
    Array.isArray(sync.upserts) &&
    sync.upserts.some((upsert) =>
      isPlainObject(upsert) && Object.hasOwn(upsert, "documentSchemaRef")
    );
};

/**
 * Packs link schemas and, when additionally negotiated, repeated document
 * metadata into a frame-local table. Schema interning may freeze its inputs.
 */
export const compressSessionSyncSchemas = (
  sync: SessionSync,
  onSchema?: (schema: JSONSchema) => void,
  includeDocumentSchemas = false,
): SessionSync | SchemaTableSessionSync => {
  const state: RewriteState = {
    schemas: new Map(),
    changed: false,
    onSchema,
  };
  let upserts = sync.upserts.map((upsert) => {
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = rewriteValue(upsert.doc, state);
    return doc === upsert.doc ? upsert : {
      ...upsert,
      doc: doc as typeof upsert.doc,
    };
  });

  if (includeDocumentSchemas) {
    upserts = compressDocumentSchemas(upserts, state);
  }

  if (!state.changed) {
    return sync;
  }

  return {
    ...sync,
    upserts,
    schemaTable: Object.fromEntries(state.schemas),
  };
};

/** Restores verified inline schemas before a sync reaches the session cache. */
export const expandSessionSyncSchemas = (
  sync: SessionSync | SchemaTableSessionSync,
  onSchema?: (schema: JSONSchema) => void,
): SessionSync => {
  const schemas = (sync as SchemaTableSessionSync).schemaTable;
  if (schemas === undefined || Object.keys(schemas).length === 0) {
    for (const upsert of sync.upserts) {
      expandDocumentSchema(upsert, schemas, onSchema);
      const ref = findSyncSchemaRef(upsert.doc);
      if (ref !== undefined) {
        expandSchemaRef(ref, schemas, onSchema);
      }
    }
    return sync;
  }

  const upserts = sync.upserts.map((wireUpsert) => {
    const upsert = expandDocumentSchema(wireUpsert, schemas, onSchema);
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = expandValue(upsert.doc, schemas, onSchema);
    // A ref surviving expansion sits at a position this expander does not
    // interpret — e.g. a legacy `$alias` schema position interned by an
    // older server. Delivering it would hand the session cache a ref
    // string as data; fail loudly instead.
    const leftover = findSyncSchemaRef(doc);
    if (leftover !== undefined) {
      throw new Error(`Unexpanded sync schema table reference: ${leftover}`);
    }
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
  includeDocumentSchemas = false,
): ServerMessage => {
  if (message.type !== "response" || message.ok === undefined) {
    return message;
  }
  if (!isPlainObject(message.ok)) {
    return message;
  }
  const sync = message.ok.sync;
  if (!isPlainObject(sync) || sync.type !== "sync") {
    return message;
  }

  return {
    ...message,
    ok: {
      ...message.ok,
      sync: compressSessionSyncSchemas(
        sync as unknown as SessionSync,
        onSchema,
        includeDocumentSchemas,
      ),
    },
  };
};

const expandResponseSync = (
  message: unknown,
  onSchema?: (schema: JSONSchema) => void,
): unknown => {
  if (!isPlainObject(message) || message.type !== "response") {
    return message;
  }
  if (!isPlainObject(message.ok)) {
    return message;
  }
  const sync = message.ok.sync;
  if (!isPlainObject(sync) || sync.type !== "sync") {
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

/** Compacts syncs in response and effect envelopes using negotiated capabilities. */
export const compressServerMessageSchemas = (
  message: ServerMessage,
  onSchema?: (schema: JSONSchema) => void,
  includeDocumentSchemas = false,
): ServerMessage => {
  if (message.type === "session/effect") {
    return {
      ...message,
      effect: compressSessionSyncSchemas(
        message.effect,
        onSchema,
        includeDocumentSchemas,
      ),
    } as SessionEffectMessage;
  }
  return compressResponseSync(message, onSchema, includeDocumentSchemas);
};

export const expandServerMessageSchemas = (
  message: unknown,
  onSchema?: (schema: JSONSchema) => void,
): unknown => {
  if (isPlainObject(message) && message.type === "session/effect") {
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
