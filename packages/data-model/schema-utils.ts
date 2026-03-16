/**
 * Runtime utilities for working with JSONSchema values.
 */

import type { JSONSchema } from "@commontools/api";
import { deepFreeze } from "./deep-freeze.ts";

/**
 * Return a deep-frozen copy of (or reference to) a JSONSchema.
 *
 * - When `canShare` is `true`, the input schema is frozen in place and
 *   returned directly. Use this when the caller owns the schema and no
 *   other code will attempt to mutate it.
 *
 * - When `canShare` is `false`, the schema is cloned first (via
 *   `structuredClone`) so that the original is not modified.
 *
 * Boolean schemas (`true` / `false`) are primitives and therefore already
 * immutable — they are returned as-is regardless of `canShare`.
 */
export function toDeepFrozenSchema(
  schema: JSONSchema,
  canShare: boolean = false,
): JSONSchema {
  // Booleans are primitives — already immutable.
  if (typeof schema === "boolean") {
    return schema;
  }

  if (canShare) {
    return deepFreeze(schema);
  }

  return deepFreeze(structuredClone(schema));
}
