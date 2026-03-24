/**
 * Modern schema hashing via canonical content identification.
 *
 * Delegates to `hashOfModern()` from `value-hash-modern.ts` to produce
 * deterministic hashes using the modern (non-merkle-reference) hashing
 * pipeline. Returns `FabricHash` directly.
 *
 * Follows the same modern/legacy split pattern used by
 * `value-hash-modern.ts` and `fabric-value-modern.ts`.
 */

import type { JSONSchema } from "@commontools/api";
import { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";
import { hashOfModern } from "./value-hash-modern.ts";

/** Modern hash of a JSONSchema, returned as a string. */
export function hashSchemaModern(schema: JSONSchema): string {
  return hashOfModern(schema).toString();
}

/** Modern hash of a schema-related item, returned as a string. */
export function hashSchemaItemModern(item: FabricValue): string {
  return hashOfModern(item).toString();
}

/** Modern hash of a schema-related item, returned as a FabricHash. */
export function hashSchemaItemModernAsFabricHash(
  item: FabricValue,
): FabricHash {
  return hashOfModern(item);
}
