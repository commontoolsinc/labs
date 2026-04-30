/**
 * Modern schema hashing via content identification.
 *
 * Delegates to `hashOf()` from `value-hash-modern.ts` to produce
 * deterministic hashes using the main value hashing pipeline. Returns
 * `FabricHash` directly.
 *
 * Follows the same modern/legacy split pattern used by
 * `fabric-value-modern.ts`.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";
import { hashOf, hashStringOf } from "./value-hash.ts";

/** Modern hash of a JSONSchema, returned as a string. */
export function hashSchemaModernAsString(schema: JSONSchema): string {
  return hashStringOf(schema);
}

/** Modern hash of a schema-related item, returned as a string. */
export function hashSchemaItemModernAsString(item: FabricValue): string {
  return hashStringOf(item);
}

/** Modern hash of a schema-related item, returned as a FabricHash. */
export function hashSchemaItemModern(
  item: FabricValue,
): FabricHash {
  return hashOf(item);
}
