/**
 * Runtime utilities for working with JSONSchema values.
 */

import type {
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaObjMutable,
  JSONSchemaTypes,
} from "@commontools/api";
import { deepFreeze, isDeepFrozen } from "./deep-freeze.ts";
import { cloneIfNecessary } from "./fabric-value.ts";
import { internSchema, isInternedSchema } from "./schema-hash.ts";
import { type FabricValue } from "./interface.ts";

/**
 * Map from `JSONSchema` type names (and special names) to corresponding
 * interned schemas. Populated lazily.
 */
const BASIC_SCHEMAS: Record<string, JSONSchemaObj> = {};

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
  // No need to do any work given an interned schema (including `boolean`s.)
  if (isInternedSchema(schema)) {
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

  // At this point, we have a mutable `schemaObj` which is allowed to be
  // directly frozen and is in fact to become the frozen return value.
  // TODO(danfuzz): `structuredClone()` will no longer be appropriate to use
  // once the schema system grows to support the full modern data model.
  const schemaRecord = schemaObj as Record<string, unknown>;
  for (const [key, value] of Object.entries(schemaRecord)) {
    schemaRecord[key] = isDeepFrozen(value)
      ? value
      : deepFreeze(structuredClone(value));
  }

  return Object.freeze(schemaObj) as T;
}

/**
 * Return a mutable object copy of a JSONSchema. Boolean schemas (`true` and
 * `false`) and `undefined` are converted to their object-form equivalents:
 * `undefined` and `true` become `{}` (accept any value), `false` becomes
 * `{ not: true }` (reject all values).
 *
 * @param deep When `true`, nested objects are recursively cloned (deep copy).
 *   Defaults to `false` (shallow copy). Pass `true` when the caller intends to
 *   mutate nested properties.
 *
 * Note: do not use this on proxy-wrapped schemas from the runtime — those
 * sites should continue using `JSON.parse(JSON.stringify(...))` until the
 * modern data-model flag graduates.
 */
export function cloneSchemaMutable(
  schema: JSONSchema | undefined,
  deep: boolean = false,
): JSONSchemaObjMutable {
  if (schema === undefined) return {};
  if (typeof schema === "boolean") return schema ? {} : { not: true };
  return cloneIfNecessary(schema, {
    frozen: false,
    deep,
  }) as JSONSchemaObjMutable;
}

/**
 * Return a deep-frozen shallow copy of a schema with the given property
 * overrides applied. This function provides "intern contagion:" If the given
 * `schema` is interned, then the result of this function will also be interned.
 *
 * - `undefined` and `true` ("accept everything") are treated as an interned
 *   `{}` before applying overrides.
 * - `false` ("reject everything") short-circuits: no overrides can make a
 *   "never" schema accept anything, so `false` is returned as-is.
 */
export function schemaWithProperties(
  schema: JSONSchema | undefined,
  overrides: JSONSchemaObj,
): JSONSchema {
  if (schema === false) return false;

  const base = (schema === undefined || schema === true)
    ? emptySchemaObject()
    : schema;
  const result = { ...base, ...overrides };

  return isInternedSchema(base)
    ? internSchema(result)
    : toDeepFrozenSchema(result, true);
}

/**
 * Return a deep-frozen shallow copy of a schema with the named properties
 * removed. This function provides "intern contagion:" If the given
 * `schema` is interned, then the result of this function will also be interned.
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

  if (copy) {
    return isInternedSchema(schema)
      ? internSchema(copy)
      : toDeepFrozenSchema(copy as JSONSchemaObj, true);
  } else {
    // Note: We still have to deep-freeze in the `!copy` case, though it will be
    // a no-op if `schema` was already deep-frozen (including interned).
    return toDeepFrozenSchema(schema);
  }
}

/**
 * Gets the basic `{ type: name }` schema for a given value. Returns `undefined`
 * if there is no well-defined type for the value. The result is always interned
 * (and frozen).
 *
 * **Note:** `undefined` (as a value) is in an "intermediate" state in the
 * codebase as of this writing, and _this_ function treats it as not having a
 * well-defined type.
 */
export function schemaForValueType(
  value: FabricValue,
): JSONSchemaObj | undefined {
  // TODO(danfuzz): This is a place that will need to get smarter once we
  // actually want to accept values beyond what's strictly allowed in JSON. This
  // notably includes `undefined` and all the other non-plain-object
  // `FabricValue` possibilities.

  const type = typeof value;
  switch (type) {
    case "object": {
      if (value === null) {
        return getBasicSchema("null");
      } else if (Array.isArray(value)) {
        return getBasicSchema("array");
      }
      break;
    }

    case "number": {
      if (Number.isInteger(value)) {
        return getBasicSchema("integer");
      }
      break;
    }

    case "bigint":
    case "symbol":
    case "undefined": {
      // Not accepted yet, even though the intention is to accept most or all
      // of these.
      return undefined;
    }
  }

  return getBasicSchema(type);
}

/**
 * Gets the standard interned empty schema _object_, a literal `{}`.
 */
export function emptySchemaObject() {
  const key = "emptySchema";
  const found = BASIC_SCHEMAS[key];
  if (found) {
    return found;
  } else {
    const result = BASIC_SCHEMAS[key] = internSchema({}) as JSONSchemaObj;
    return result;
  }
}

/**
 * Helper for `schemaForValueType()` and `emptySchemaObject()` to do the
 * lookup and interning as necessary.
 */
function getBasicSchema(key: string) {
  const found = BASIC_SCHEMAS[key];

  if (found) {
    return found;
  } else {
    const result = BASIC_SCHEMAS[key] = internSchema({
      type: key as JSONSchemaTypes,
    }) as JSONSchemaObj;
    return result;
  }
}
