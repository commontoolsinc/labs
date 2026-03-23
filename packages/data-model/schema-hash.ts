/**
 * Schema hashing dispatch layer.
 *
 * Provides `hashSchema` and `hashSchemaPathSelector` — deterministic string
 * hashes for schemas and schema path selectors. Currently delegates to the
 * legacy `stableStringify` implementation in `schema-hash-legacy.ts`.
 *
 * Follows the same dispatch + modern/legacy split pattern used by
 * `value-hash.ts` / `fabric-value.ts`: a future flag will switch the
 * dispatch to canonical hashing via `modernHash`.
 */

import type { JSONSchema } from "@commontools/api";
import type { SchemaPathSelector } from "./interface.ts";
import {
  hashSchemaLegacy,
  hashSchemaPathSelectorLegacy,
} from "./schema-hash-legacy.ts";

/**
 * Compute a deterministic string hash of a JSONSchema.
 * Structurally-equal schemas always produce the same hash.
 */
export function hashSchema(schema: JSONSchema): string {
  return hashSchemaLegacy(schema);
}

/**
 * Compute a deterministic string hash of a SchemaPathSelector.
 * Structurally-equal selectors always produce the same hash.
 */
export function hashSchemaPathSelector(selector: SchemaPathSelector): string {
  return hashSchemaPathSelectorLegacy(selector);
}
