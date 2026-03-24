/**
 * Modern schema hashing via canonical content identification.
 *
 * Stub implementation — the modern schema hashing path is not yet
 * implemented. These functions are dispatch targets for `schema-hash.ts`
 * when the `modernSchemaHash` experiment flag is ON. They will be filled
 * in once the canonical schema hashing design is finalized.
 *
 * Follows the same modern/legacy split pattern used by
 * `value-hash-modern.ts` and `fabric-value-modern.ts`.
 */

import type { JSONSchema } from "@commontools/api";
import type { FabricValue } from "./interface.ts";

/** Modern hash of a JSONSchema (not yet implemented). */
export function hashSchemaModern(_schema: JSONSchema): string {
  throw new Error(
    "hashSchemaModern is not yet implemented — " +
      "the modernSchemaHash experiment flag should not be enabled",
  );
}

/** Modern hash of a schema-related item (not yet implemented). */
export function hashSchemaItemModern(
  _item: FabricValue,
): string {
  throw new Error(
    "hashSchemaItemModern is not yet implemented — " +
      "the modernSchemaHash experiment flag should not be enabled",
  );
}
