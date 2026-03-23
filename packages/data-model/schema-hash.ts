/**
 * Schema hashing dispatch layer.
 *
 * Provides `hashSchema` and `hashSchemaPathSelector` — deterministic string
 * hashes for schemas and schema path selectors. Dispatches between legacy
 * `stableStringify` (schema-hash-legacy.ts) and canonical hashing
 * (schema-hash-modern.ts) based on a runtime flag.
 *
 * Follows the same dispatch + modern/legacy split pattern used by
 * `value-hash.ts` / `fabric-value.ts`.
 */

import type { JSONSchema } from "@commontools/api";
import type { SchemaPathSelector } from "./interface.ts";
import {
  hashSchemaLegacy,
  hashSchemaPathSelectorLegacy,
} from "./schema-hash-legacy.ts";
import {
  hashSchemaModern,
  hashSchemaPathSelectorModern,
} from "./schema-hash-modern.ts";

// ---------------------------------------------------------------------------
// Flag-dispatched public API
//
// These two symbols are reassigned by `configureDispatch()` whenever
// the schema hash mode changes. The two implementation worlds (modern
// vs. legacy/stableStringify) are kept in fully separate modules so that
// NO code changes when the experiment flag is off.
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic string hash of a JSONSchema.
 * Structurally-equal schemas always produce the same hash.
 */
export let hashSchema: (schema: JSONSchema) => string;

/**
 * Compute a deterministic string hash of a SchemaPathSelector.
 * Structurally-equal selectors always produce the same hash.
 */
export let hashSchemaPathSelector: (selector: SchemaPathSelector) => string;

// ---------------------------------------------------------------------------
// Modern schema hash mode flag and dispatch configuration
// ---------------------------------------------------------------------------

/**
 * Module-level flag for modern schema hash mode, set by the `Runtime`
 * constructor via `setSchemaHashConfig()`. When enabled, the public API
 * symbols dispatch to modern hash implementations instead of
 * stableStringify.
 */
let modernSchemaHashEnabled = false;

/**
 * Reassign the public API symbols based on the current value of
 * `modernSchemaHashEnabled`. Called at module load and whenever the flag
 * changes.
 */
function configureDispatch(): void {
  if (modernSchemaHashEnabled) {
    hashSchema = hashSchemaModern;
    hashSchemaPathSelector = hashSchemaPathSelectorModern;
  } else {
    hashSchema = hashSchemaLegacy;
    hashSchemaPathSelector = hashSchemaPathSelectorLegacy;
  }
}

/**
 * Activates or deactivates modern schema hash mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.modernSchemaHash` into the
 * memory layer.
 */
export function setSchemaHashConfig(enabled: boolean): void {
  modernSchemaHashEnabled = enabled;
  configureDispatch();
}

/**
 * Restores modern schema hash mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetSchemaHashConfig(): void {
  modernSchemaHashEnabled = false;
  configureDispatch();
}

// ---------------------------------------------------------------------------
// Initialize dispatch to legacy mode at module load.
// ---------------------------------------------------------------------------

configureDispatch();
