/**
 * Runtime utilities for working with JSONSchema values.
 */

import type { JSONSchema, JSONSchemaObj } from "@commontools/api";
import { deepFreeze, isDeepFrozen } from "./deep-freeze.ts";

/**
 * Indicates if the given (nullable) schema is in fact a non-trivial schema. A
 * non-trivial schema is defined as one that is an `object` with at least one
 * property.
 */
export function isNontrivialSchema(
  schema: JSONSchema | undefined | null,
): schema is JSONSchemaObj {
  if ((schema === null) || (typeof schema !== "object")) {
    return false;
  }

  return Object.keys(schema).length !== 0;
}

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
export function toDeepFrozenSchema<T extends JSONSchema>(
  schema: T,
  canShare: boolean = false,
): T {
  // Booleans are primitives — already immutable.
  if (typeof schema === "boolean") {
    return schema;
  }

  // After the boolean check, `schema` is necessarily a `JSONSchemaObj`. We use
  // a local `schemaObj` variable so TypeScript can track the object-only type through
  // the spread and freeze operations, then cast back to `T` on return.
  let schemaObj = schema as Exclude<T, boolean>;

  if (Object.isFrozen(schemaObj)) {
    // `schemaObj` is already frozen...
    if (isDeepFrozen(schemaObj)) {
      // ...and is in fact already deep-frozen, so we can return it directly.
      return schemaObj as T;
    } else {
      // ...but it's not deep-frozen, so we have to shallow-clone and modify
      // (even if `canShare === true`).
      schemaObj = { ...schemaObj };
    }
  } else if (!canShare) {
    // `schemaObj` is not frozen but also can't be modified; shallow-clone it.
    schemaObj = { ...schemaObj };
  }

  // At this point, we have a mutable `schemaObj` which is allowed to be mutated
  // and is to become the frozen return value. TODO(danfuzz):
  // `structuredClone()` will no longer be appropriate to use once the schema
  // system grows to support the full rich-data model.
  const schemaRecord = schemaObj as Record<string, unknown>;
  for (const [key, value] of Object.entries(schemaRecord)) {
    schemaRecord[key] = isDeepFrozen(value)
      ? value
      : deepFreeze(structuredClone(value));
  }

  return Object.freeze(schemaObj) as T;
}
