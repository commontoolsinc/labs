/**
 * Schema hashing dispatch layer.
 *
 * Provides `hashSchema` and `hashSchemaItem` — deterministic string
 * hashes for schemas and general schema-related items. Dispatches between
 * legacy `stableStringify` (schema-hash-legacy.ts) and canonical hashing
 * (schema-hash-modern.ts) based on a runtime flag.
 *
 * Follows the same inline-flag-test dispatch pattern used by
 * `fabric-value.ts`.
 */

import type { JSONSchema } from "@commontools/api";
import type { FabricValue } from "./interface.ts";
import {
  hashSchemaItemLegacy,
  hashSchemaLegacy,
} from "./schema-hash-legacy.ts";
import {
  hashSchemaItemModern,
  hashSchemaModern,
} from "./schema-hash-modern.ts";

// ---------------------------------------------------------------------------
// Modern schema hash mode flag
// ---------------------------------------------------------------------------

let modernSchemaHashEnabled = false;

/**
 * Activates or deactivates modern schema hash mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.modernSchemaHash` into the
 * memory layer.
 */
export function setSchemaHashConfig(enabled: boolean): void {
  modernSchemaHashEnabled = enabled;
}

/**
 * Restores modern schema hash mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetSchemaHashConfig(): void {
  modernSchemaHashEnabled = false;
}

// ---------------------------------------------------------------------------
// Flag-dispatched public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic string hash of a JSONSchema.
 * Structurally-equal schemas always produce the same hash.
 */
export function hashSchema(schema: JSONSchema): string {
  return modernSchemaHashEnabled
    ? hashSchemaModern(schema)
    : hashSchemaLegacy(schema);
}

/**
 * Compute a deterministic string hash of a schema-related item (e.g. a
 * path selector, a value descriptor, etc.). Structurally-equal items
 * always produce the same hash.
 */
export function hashSchemaItem(item: FabricValue): string {
  return modernSchemaHashEnabled
    ? hashSchemaItemModern(item)
    : hashSchemaItemLegacy(item);
}
