/**
 * The durable `schema` metadata of a result document — the reserved root
 * member `EntityDocument.schema` (`docs/specs/memory-v2/01-data-model.md`)
 * that a piece's setup writes with its pattern's result schema and a
 * receipt-only handling writes with the shape of what it stored. It is
 * spelled the way a link spells its schema: an inline JSON Schema, or —
 * under `contentAddressedSchemas` — a `{ "$ref": "cid:<hash>" }` reference
 * to a content-addressed schema document whose closure the commit installs
 * into the space alongside the reference
 * (`docs/specs/content-addressed-schemas.md`, "References in result-schema
 * metadata"). Readers take the inline form back through
 * {@link readResultSchemaMeta}; the stored spelling is
 * {@link resultSchemaMetaSpelling}.
 */
import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isNontrivialSchema } from "@commonfabric/data-model-schema";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { Cell } from "./cell.ts";
import { externalizeSchema } from "./link-utils.ts";
import { rawMetaWriteAuthorization } from "./meta-seam.ts";
import { recomposeSchemaRefs, SCHEMA_META_MEMBER } from "./schema-decompose.ts";
import { getContentAddressedSchemasConfig } from "./schema-doc-config.ts";
import { lookupSchemaDocument } from "./schema-registry.ts";
import type { IReadOptions } from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";

/**
 * The spelling the `schema` metadata takes for `schema`: a content-addressed
 * reference when the flag is on and decomposition accepts the input, the
 * schema itself otherwise. A trivial schema — `{}`, `true`, anything that
 * constrains nothing — stays inline, as it does on a link: a document that
 * says nothing is not worth a document. Externalizing registers the closure
 * in the realm registry, and the commit pipeline stages it into the space
 * from there (`#stageSchemaDocsForValue`, which reads the `schema` member of
 * a written document the way it reads a link position). The schema is NOT
 * sanitized: the metadata describes the document in full, `asCell` entries
 * included, which is what lets a reader recover a typed handle from it.
 */
export function resultSchemaMetaSpelling(schema: JSONSchema): JSONSchema {
  if (
    !getContentAddressedSchemasConfig() || !isObjectNotArray(schema) ||
    !isNontrivialSchema(schema)
  ) {
    return schema;
  }
  return externalizeSchema(schema as JSONSchemaObj);
}

/**
 * Writes `schema` as `cell`'s document's `schema` metadata in its stored
 * spelling, skipping the write when the stored spelling already matches.
 * Returns whether a write was issued. `cell` must carry a transaction.
 */
export function writeResultSchemaMeta(
  cell: Cell<unknown>,
  schema: JSONSchema,
): boolean {
  const spelling = resultSchemaMetaSpelling(schema);
  const previous = cell.getMetaRaw(SCHEMA_META_MEMBER, {
    meta: ignoreReadForScheduling,
  });
  if (deepEqual(previous, spelling)) return false;
  cell.setMetaRaw(SCHEMA_META_MEMBER, spelling, rawMetaWriteAuthorization);
  return true;
}

/**
 * The `schema` metadata of `cell`'s document in the inline form every
 * consumer walks, recomposed through the realm registry when stored as a
 * reference. A reference whose closure the registry cannot supply yet is
 * returned as stored: the read-time resolver fails closed on it (a
 * `{ "$ref": "cid:…" }` root resolves to nothing until its document
 * arrives), which is the same posture a reference-bearing link takes.
 * `undefined` when the document carries no schema metadata.
 */
export function readResultSchemaMeta(
  cell: Cell<unknown>,
  options?: IReadOptions,
): JSONSchema | undefined {
  const stored = cell.getMetaRaw(SCHEMA_META_MEMBER, options);
  if (stored === undefined || stored === null) return undefined;
  const schema = stored as JSONSchema;
  try {
    return recomposeSchemaRefs(schema, lookupSchemaDocument);
  } catch {
    return schema;
  }
}
