import type { FabricValue, JSONSchema } from "@commonfabric/api";
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
import { mapLinkSchemas, SCHEMA_CAS_REF_PREFIX } from "./schema-table-links.ts";

type SchemaTable = Record<string, JSONSchema>;

export type SchemaTableSessionSync = SessionSync & {
  schemaTable?: SchemaTable;
};

/**
 * Tagged hashes of the schema bodies a peer already holds.
 *
 * Passing one selects the connection-scoped encoding: a schema is written to
 * the frame's `schemaTable` only when the peer does not hold it yet, and every
 * reference is minted under {@link SCHEMA_CAS_REF_PREFIX}. Omitting it selects
 * the frame-local encoding, where each frame carries the body of every schema
 * it names.
 */
export type DeliveredSchemas = ReadonlySet<string>;

/**
 * Schema bodies a peer has been delivered, by tagged hash.
 *
 * The receiving half of {@link DeliveredSchemas}: entries are added as frames
 * carry them and read back when a later frame names a hash without carrying
 * its body.
 */
export type SchemaCache = Map<string, JSONSchema>;

/** A compressed message, and what its delivery would teach the peer. */
export type CompressedServerMessage = {
  message: ServerMessage;
  /**
   * Tagged hashes whose schema bodies ride on THIS message — what the sender
   * may add to its {@link DeliveredSchemas} once the message reaches the
   * transport, and not one moment sooner: a staged body that never arrives
   * strands every later reference naming it. Always empty under the
   * frame-local encoding, which re-sends every body and so has nothing to
   * remember.
   */
  staged: ReadonlySet<string>;
};

const NO_STAGED_SCHEMAS: ReadonlySet<string> = new Set();

type RewriteState = {
  schemas: Map<string, JSONSchema>;
  changed: boolean;
  delivered?: DeliveredSchemas;
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
  if (state.delivered === undefined) {
    state.schemas.set(hash, schemaAndHash.schema);
    return `${SYNC_SCHEMA_REF_PREFIX}${hash}`;
  }
  // Connection-scoped: a body the peer already holds is not written again,
  // so a steady-state frame carries references and no table at all.
  if (!state.delivered.has(hash)) {
    state.schemas.set(hash, schemaAndHash.schema);
  }
  return `${SCHEMA_CAS_REF_PREFIX}${hash}`;
};

/**
 * The reserved prefix `value` carries, or undefined when it is not a
 * reference. A `schema-cas@1:` reference may resolve from the cache; a
 * `schema-ref@2:` one may not — its contract is that the body travels on the
 * same frame, so a missing table entry is a sender defect and must be
 * reported as one rather than silently satisfied by an unrelated cache hit.
 */
const refPrefixOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (value.startsWith(SYNC_SCHEMA_REF_PREFIX)) return SYNC_SCHEMA_REF_PREFIX;
  if (value.startsWith(SCHEMA_CAS_REF_PREFIX)) return SCHEMA_CAS_REF_PREFIX;
  return undefined;
};

const expandSchemaRef = (
  value: unknown,
  schemas: SchemaTable | undefined,
  cache?: SchemaCache,
): JSONSchema | undefined => {
  const prefix = refPrefixOf(value);
  if (prefix === undefined) return undefined;
  const ref = value as string;
  const hash = ref.slice(prefix.length);

  if (
    hash.length > 0 && schemas !== undefined && Object.hasOwn(schemas, hash)
  ) {
    const schemaAndHash = internSchema(schemas[hash], true);
    if (schemaAndHash.taggedHashString !== hash) {
      throw new Error(
        `Invalid sync schema table content for reference: ${ref}`,
      );
    }
    // Verified once, on arrival: the cache holds interned bodies whose hash
    // has already been checked against the reference that carried them.
    if (prefix === SCHEMA_CAS_REF_PREFIX) {
      cache?.set(hash, schemaAndHash.schema);
    }
    return schemaAndHash.schema;
  }

  if (prefix === SCHEMA_CAS_REF_PREFIX && hash.length > 0) {
    const cached = cache?.get(hash);
    if (cached !== undefined) return cached;
  }

  throw new Error(`Invalid sync schema table reference: ${ref}`);
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
  cache?: SchemaCache,
): FabricValue => expandSchemaRef(value, schemas, cache) ?? value;

const rewriteValue = (value: FabricValue, state: RewriteState): FabricValue =>
  mapLinkSchemas(value, (schema) => rewriteSchemaValue(schema, state));

const expandValue = (
  value: FabricValue,
  schemas: SchemaTable | undefined,
  cache?: SchemaCache,
): FabricValue =>
  mapLinkSchemas(
    value,
    (schema) => expandSchemaValue(schema, schemas, cache),
  );

export const compressSessionSyncSchemas = (
  sync: SessionSync,
  delivered?: DeliveredSchemas,
): SessionSync | SchemaTableSessionSync => {
  const state: RewriteState = {
    schemas: new Map(),
    changed: false,
    delivered,
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
    // A connection-scoped frame that names only already-delivered schemas
    // has no table to carry; omitting the key keeps it off the wire rather
    // than shipping an empty object on every steady-state frame.
    ...(state.schemas.size > 0
      ? { schemaTable: Object.fromEntries(state.schemas) }
      : {}),
  };
};

export const expandSessionSyncSchemas = (
  sync: SessionSync | SchemaTableSessionSync,
  cache?: SchemaCache,
): SessionSync => {
  const schemas = (sync as SchemaTableSessionSync).schemaTable;
  if (
    cache === undefined &&
    (schemas === undefined || Object.keys(schemas).length === 0)
  ) {
    // Frame-local encoding with nothing to resolve against. A reference here
    // sits at a position this expander does not interpret — a legacy `$alias`
    // schema position interned by an older server — so there is nothing to
    // rewrite; report it rather than hand the session cache a ref as data.
    // A connection-scoped receiver never takes this path: its references are
    // expected to outlive the frame that carried their bodies.
    for (const upsert of sync.upserts) {
      const ref = findSyncSchemaRef(upsert.doc);
      if (ref !== undefined) {
        expandSchemaRef(ref, schemas, undefined);
      }
    }
    return sync;
  }

  const upserts = sync.upserts.map((upsert) => {
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = expandValue(upsert.doc, schemas, cache);
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

/** The hashes a compressed sync placed on its frame — exactly its table's
 *  keys, since a body is written there only when the peer lacks it. */
const stagedFrom = (
  sync: SessionSync | SchemaTableSessionSync,
): ReadonlySet<string> => {
  const table = (sync as SchemaTableSessionSync).schemaTable;
  return table === undefined ? NO_STAGED_SCHEMAS : new Set(Object.keys(table));
};

const compressResponseSync = (
  message: ServerMessage,
  delivered?: DeliveredSchemas,
): CompressedServerMessage => {
  if (message.type !== "response" || message.ok === undefined) {
    return { message, staged: NO_STAGED_SCHEMAS };
  }
  if (!isPlainRecord(message.ok)) {
    return { message, staged: NO_STAGED_SCHEMAS };
  }
  const sync = message.ok.sync;
  if (!isPlainRecord(sync) || sync.type !== "sync") {
    return { message, staged: NO_STAGED_SCHEMAS };
  }

  const compressed = compressSessionSyncSchemas(
    sync as unknown as SessionSync,
    delivered,
  );
  return {
    message: {
      ...message,
      ok: { ...message.ok, sync: compressed },
    },
    staged: delivered === undefined
      ? NO_STAGED_SCHEMAS
      : stagedFrom(compressed),
  };
};

const expandResponseSync = (
  message: unknown,
  cache?: SchemaCache,
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
        cache,
      ),
    },
  };
};

/**
 * Rewrites the schemas a server message carries into hash references.
 *
 * With `delivered`, the connection-scoped encoding applies: a body travels
 * only on the first frame of the connection that names it, and the returned
 * `staged` set names what this frame teaches the peer. Without it, the
 * frame-local encoding applies and `staged` is empty.
 */
export const compressServerMessageSchemas = (
  message: ServerMessage,
  delivered?: DeliveredSchemas,
): CompressedServerMessage => {
  if (message.type === "session/effect") {
    const effect = compressSessionSyncSchemas(message.effect, delivered);
    return {
      message: { ...message, effect } as SessionEffectMessage,
      staged: delivered === undefined ? NO_STAGED_SCHEMAS : stagedFrom(effect),
    };
  }
  return compressResponseSync(message, delivered);
};

/**
 * Restores the schemas a server message references.
 *
 * With `cache`, connection-scoped references resolve against bodies delivered
 * on earlier frames, and bodies arriving on this one are recorded there.
 */
export const expandServerMessageSchemas = (
  message: unknown,
  cache?: SchemaCache,
): unknown => {
  if (isPlainRecord(message) && message.type === "session/effect") {
    return {
      ...message,
      effect: expandSessionSyncSchemas(
        message.effect as SchemaTableSessionSync,
        cache,
      ),
    };
  }
  return expandResponseSync(message, cache);
};
