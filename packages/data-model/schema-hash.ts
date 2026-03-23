/**
 * Schema hashing dispatch layer.
 *
 * Provides `hashSchema` and `hashSchemaPathSelector` — deterministic string
 * hashes for schemas and schema path selectors. Dispatches between legacy
 * `stableStringify` (schema-hash-legacy.ts) and canonical hashing
 * (schema-hash-modern.ts) based on a runtime flag.
 *
 * Follows the same inline-flag-test dispatch pattern used by
 * `fabric-value.ts`.
 */

import type { JSONSchema, SchemaPathSelector } from "@commontools/api";
import {
  hashSchemaLegacy,
  hashSchemaPathSelectorLegacy,
} from "./schema-hash-legacy.ts";
import {
  hashSchemaModern,
  hashSchemaPathSelectorModern,
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
 * Compute a deterministic string hash of a SchemaPathSelector.
 * Structurally-equal selectors always produce the same hash.
 */
export function hashSchemaPathSelector(selector: SchemaPathSelector): string {
  return modernSchemaHashEnabled
    ? hashSchemaPathSelectorModern(selector)
    : hashSchemaPathSelectorLegacy(selector);
}
