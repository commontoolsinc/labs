/** Runtime utilities for working with JSONSchema values. */

import type {
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaTypes,
  MutableJSONSchemaObj,
} from "@commonfabric/api";

import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import {
  cloneIfNecessary,
  FabricPrimitive,
  type FabricValue,
  shallowMutableClone,
} from "@commonfabric/data-model/fabric-value";
import {
  internSchema,
  internSchemaAsTaggedHashString,
  isInternedSchema,
} from "./schema-intern.ts";
import { schemaTypeOfFabricPrimitive } from "./schemaTypeOfFabricPrimitive.ts";

/**
 * Map from `JSONSchema` type names (and special names) to corresponding
 * interned schemas. Populated lazily.
 */
const BASIC_SCHEMAS: Record<string, JSONSchemaObj> = {};

/**
 * Helper for `schemaForValueType()` and `emptySchemaObject()`, which does
 * the lookup and interning as necessary.
 */
function getBasicSchema(key: string) {
  const found = BASIC_SCHEMAS[key];

  if (found) {
    return found;
  } else {
    const result = BASIC_SCHEMAS[key] = internSchema({
      type: key as JSONSchemaTypes,
    });
    return result;
  }
}

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
 * Returns a deep-frozen copy of (or reference to) a JSONSchema, returning
 * primitives as-is.
 *
 * - When `canShare` is `true`, the input `schema` is allowed to be modified,
 *   including freezing it in place and returning it directly. Use this when the
 *   caller owns the object referred to by `schema` and no other code will
 *   attempt to mutate it.
 *
 * - When `canShare` is `false`, the `schema` is cloned first if not already
 *   deep-frozen, so that the original is not modified.
 *
 * As with other schema functions, this one accepts `undefined` for use when
 * it's possible for a schema value to be missing or optional.
 *
 * Note: Use `internSchema()` in preference to this function, which can cost a
 * little more to run but which will save both time and memory when the schema
 * in question is reused.
 */
export function toDeepFrozenSchema<T extends JSONSchema | undefined>(
  schema: T,
  canShare: boolean = false,
): T {
  // No need to do any work given an interned schema (including `boolean`s.)
  if (isInternedSchema(schema)) {
    return schema;
  }

  // After the boolean check, `schema` is necessarily a `JSONSchemaObj`. We use
  // a local `schemaObj` variable so TypeScript can track the object-only type,
  // then cast back to `T` on return.
  const schemaObj = schema as Exclude<T, boolean>;

  if (canShare) {
    // The caller indicated that we get to freeze the result, so just do that.
    // The call to `deepFreeze()` is a relatively inexpensive no-op if
    // `schemaObj` is in fact already deep-frozen.
    return deepFreeze(schemaObj);
  } else {
    // The caller indicated that the original `schema` has to be left alone, so
    // make a deep-frozen clone of it. As with `deepFreeze()`, if it turns out
    // `schemaObj` is already deep-frozen, the call is a relatively inexpensive
    // no-op.
    return cloneIfNecessary(schemaObj) as T;
  }
}

/**
 * Returns a mutable object copy of a JSONSchema. Boolean schemas (`true` and
 * `false`) and `undefined` are converted to their object-form equivalents:
 * `undefined` and `true` become `{}` (accept any value), `false` becomes
 * `{ not: true }` (reject all values).
 *
 * @param deep When `true`, nested objects are recursively cloned (deep copy).
 *   Defaults to `false` (shallow copy). Pass `true` when the caller intends to
 *   mutate nested properties.
 */
export function cloneSchemaMutable(
  schema: JSONSchema | undefined,
  deep: boolean = false,
): MutableJSONSchemaObj {
  if (schema === undefined) return {};
  if (typeof schema === "boolean") return schema ? {} : { not: true };
  return cloneIfNecessary(schema, {
    frozen: false,
    deep,
  }) as MutableJSONSchemaObj;
}

/**
 * Returns a deep-frozen shallow copy of a schema with the given property
 * overrides applied. This function provides "intern contagion:" If the given
 * `schema` is interned, then the result of this function will also be interned.
 *
 * - `undefined` and `true` ("accept everything") are treated as an interned
 *   `{}`.
 * - `false` ("reject everything"), whether in `schema` or `overrides`, results
 *   in a `false` result. That is, adding properties to a "never" schema still
 *   results in "never," and adding "never" to any schema makes it a "never."
 */
export function schemaWithProperties(
  schema: JSONSchema | undefined,
  overrides: JSONSchema,
): JSONSchema {
  schema ??= true;

  if (typeof schema === "boolean") {
    if (schema === false) {
      return false;
    } else if (typeof overrides === "boolean") {
      return overrides;
    } else {
      // Since `schema` is (definitionally) interned, "intern contagion"
      // applies, and the result is to be interned. We need to "manually" call
      // `toDeepFrozenSchema()` to ensure the value can become owned by the
      // intern cache (because an un-frozen argument needs to remain untouched).
      return internSchema(toDeepFrozenSchema(overrides));
    }
  }

  // `schema` is an object.

  if (typeof overrides === "boolean") {
    if (overrides === false) {
      return false;
    } else {
      // Note: This covers the "intern contagion" case, since
      // `toDeepFrozenSchema()` returns the given schema if already deep-frozen,
      // and interned schemas are definitionally deep-frozen.
      return toDeepFrozenSchema(schema);
    }
  }

  // Both `schema` and `overrides` are objects.

  // `shallowMutableClone()` gives a mutable top-level object whose bound
  // children are deep-frozen -- cloning any mutable ones rather than freezing
  // the `schema`/`overrides` inputs in place -- so the subsequent
  // `toDeepFrozenSchema(result, true)` only has to seal the (owned) top.
  const result = shallowMutableClone(
    { ...schema, ...overrides },
  ) as JSONSchemaObj;
  return isInternedSchema(schema)
    ? internSchema(result)
    : toDeepFrozenSchema(result, true);
}

/**
 * Returns a deep-frozen shallow copy of a schema with the named properties
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
    // See `schemaWithProperties()`: deep-freeze the bound children (cloning any
    // mutable ones, leaving the `schema` input untouched) so the subsequent
    // `toDeepFrozenSchema` only has to seal the owned top.
    const result = shallowMutableClone(
      copy as FabricValue,
    ) as JSONSchemaObj;
    return isInternedSchema(schema)
      ? internSchema(result)
      : toDeepFrozenSchema(result, true);
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
      } else if (value instanceof FabricPrimitive) {
        // A `FabricPrimitive` gets its specific type name (e.g.
        // "FabricBytes") rather than "object": it is an opaque leaf, so
        // "object" would invite structural keywords that cannot apply.
        return getBasicSchema(schemaTypeOfFabricPrimitive(value));
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

/** Gets the standard interned empty schema _object_, a literal `{}`. */
export function emptySchemaObject() {
  const key = "emptySchema";
  const found = BASIC_SCHEMAS[key];
  if (found) {
    return found;
  } else {
    const result = BASIC_SCHEMAS[key] = internSchema({});
    return result;
  }
}

/**
 * Returns a cache-key string for an ordered pair of schemas, each interned
 * (and thus deep-frozen) via `internSchema()`. The `|` delimiter is outside
 * the base64url alphabet used by hash strings, so the two halves cannot
 * merge ambiguously.
 */
export function internSchemaPairAsKey(a: JSONSchema, b: JSONSchema): string {
  return `${internSchemaAsTaggedHashString(a)}|${
    internSchemaAsTaggedHashString(b)
  }`;
}
