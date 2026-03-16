/**
 * Runtime utilities for working with JSONSchema values.
 */

import type { JSONSchema } from "@commontools/api";
import { deepFreeze, isDeepFrozen } from "./deep-freeze.ts";

/**
 * Return a deep-frozen copy of (or reference to) a JSONSchema.
 *
 * - When `canShare` is `true`, the input `schema` is allowed to be modified,
 *   including freezing it in place and returning it directly. Use this when the
 *   caller owns the object referred to by `schema` and no other code will
 *   attempt to mutate it.
 *
 * - When `canShare` is `false`, the `schema` is cloned first if not already
 *   deep-frozen, so that the original is not modified.
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

  if (Object.isFrozen(schema)) {
    // `schema` is already frozen...
    if (isDeepFrozen(schema)) {
      // ...and is in fact already deep-frozen, so we can return it directly.
      return schema;
    } else {
      // ...but it's not deep-frozen, so we have to shallow-clone and modify
      // (even if `canShare === true`).
      schema = { ...schema };
    }
  } else if (!canShare) {
    // `schema` is not frozen but also can't be modified; shallow-clone it.
    schema = { ...schema };
  }

  // At this point, we have a mutable `schema` which is allowed to be mutated
  // and is to become the frozen return value. TODO(danfuzz):
  // `structuredClone()` will no longer be appropriate to use once the schema
  // system grows to support the full rich-data model.
  const schemaRecord = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries(schemaRecord)) {
    schemaRecord[key] = isDeepFrozen(value)
      ? value
      : deepFreeze(structuredClone(value));
  }

  return Object.freeze(schema);
}
