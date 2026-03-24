/**
 * Modern schema hashing via canonical content identification.
 *
 * Delegates to `hashOfModern()` from `value-hash-modern.ts` to produce
 * deterministic hashes using the modern (non-merkle-reference) hashing
 * pipeline. The string representation of the resulting `FabricHash` is
 * returned.
 *
 * Follows the same modern/legacy split pattern used by
 * `value-hash-modern.ts` and `fabric-value-modern.ts`.
 */

import type { JSONSchema } from "@commontools/api";
import type { FabricValue } from "./interface.ts";
import { hashOfAsRawStringModern } from "./value-hash-modern.ts";

/** Modern hash of a JSONSchema. */
export function hashSchemaModern(schema: JSONSchema): string {
  return hashOfAsRawStringModern(schema);
}

/** Modern hash of a schema-related item. */
export function hashSchemaItemModern(
  item: FabricValue,
): string {
  return hashOfAsRawStringModern(item);
}
