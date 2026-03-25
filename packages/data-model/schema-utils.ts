/**
 * Runtime utilities for working with JSONSchema values.
 */

import type {
  JSONSchema,
  JSONSchemaMutable,
  JSONSchemaObj,
} from "@commontools/api";
import { deepFreeze, isDeepFrozen } from "./deep-freeze.ts";
import { cloneIfNecessary } from "./fabric-value.ts";

/**
 * Indicates if the given (nullable) schema is in fact a non-trivial schema. A
 * non-trivial schema is defined as one that is an `object` with at least one
 * property. If it returns `true`, type-narrowing ensures that the schema
 * _object_ can be treated as such.
 *
 * **Note:** Because of TS narrowing rules, when this function returns `false`
 * given `{}` (empty object), TS will mistakenly treat this as type `boolean |
 * undefined | null`. This is technically wrong but, given the meaning of this
 * method, effectively safe in that the point of this method is enabling easy
 * object use in the `true` cases and pretty much saying "don't mess with the
 * value" in `false` cases.
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

/**
 * Return a deep mutable copy of a JSONSchema. Boolean and `undefined` schemas
 * are returned as `{}` when `forceObject` is `true`; boolean schemas are
 * returned as-is otherwise, and `undefined` returns `{}`.
 *
 * Note: do not use this on proxy-wrapped schemas from the runtime — those
 * sites should continue using `JSON.parse(JSON.stringify(...))` until the
 * modern data-model flag graduates.
 */
export function cloneSchemaMutable(
  schema: JSONSchema | undefined,
  forceObject: true,
): JSONSchemaMutable;
export function cloneSchemaMutable(
  schema: JSONSchema | undefined,
  forceObject?: false,
): JSONSchemaMutable | boolean;
export function cloneSchemaMutable(
  schema: JSONSchema | undefined,
  forceObject: boolean = false,
): JSONSchemaMutable | boolean {
  if (schema === undefined) return {};
  if (typeof schema === "boolean") return forceObject ? {} : schema;
  return cloneIfNecessary(schema, {
    frozen: false,
    deep: true,
  }) as JSONSchemaMutable;
}

/**
 * Return a frozen shallow copy of a schema with the given property overrides
 * applied.
 *
 * - `undefined` and `true` ("accept everything") are treated as `{}` before
 *   applying overrides.
 * - `false` ("reject everything") short-circuits: no overrides can make a
 *   "never" schema accept anything, so `false` is returned as-is.
 */
export function schemaWithProperties(
  schema: JSONSchema | undefined,
  overrides: JSONSchemaObj,
): JSONSchema {
  if (schema === false) return false;
  const base = (schema === undefined || schema === true) ? {} : schema;
  return toDeepFrozenSchema({ ...base, ...overrides }, true);
}

/**
 * Return a deep-frozen shallow copy of a schema with the named properties
 * removed.
 *
 * `undefined` is treated as `true` (JSON Schema "accept everything").
 * Boolean schemas are returned as-is (no properties to remove).
 */
export function schemaWithoutProperties(
  schema: JSONSchema | undefined,
  ...names: string[]
): JSONSchema {
  if (schema === undefined) return true;
  if (typeof schema === "boolean") return schema;

  let copy: Record<string, unknown> | null = null;

  for (const name of names) {
    if (copy) {
      delete copy[name];
    } else if (Object.hasOwn(schema, name)) {
      // First time we've found a `name` in need of deletion.
      copy = { ...schema };
      delete copy[name];
    }
  }

  // Note: Still have to deep-freeze in the `!copy` case, though it will be a
  // no-op if `schema` was already deep-frozen.
  return copy
    ? toDeepFrozenSchema(copy as JSONSchemaObj, true)
    : toDeepFrozenSchema(schema);
}
