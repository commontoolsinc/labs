/**
 * Runtime utilities for working with JSONSchema values.
 */

import type {
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaObjMutable,
  JSONSchemaTypes,
  SchemaPathSelector,
} from "@commonfabric/api";

import { deepFreeze } from "./deep-freeze.ts";
import { cloneIfNecessary, shallowMutableClone } from "./fabric-value.ts";
import {
  internSchema,
  internSchemaAsTaggedHashString,
  isInternedSchema,
} from "./schema-hash.ts";
import { type FabricValue } from "./interface.ts";

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
    }) as JSONSchemaObj;
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
 * Returns a deep-frozen copy of (or reference to) a JSONSchema.
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
 *
 * Note: Use `internSchema()` in preference to this function, which can cost a
 * little more to run but which will save both time and memory when the schema
 * in question is reused.
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
 *
 * Note: do not use this on proxy-wrapped schemas from the runtime — those
 * sites currently use `JSON.parse(JSON.stringify(...))` instead.
 *
 * TODO(danfuzz): Get those runtime sites off the
 * `JSON.parse(JSON.stringify(...))` round-trip — e.g. by teaching this
 * function to handle proxy-wrapped schemas — so nothing relies on a
 * stringify/parse round-trip to normalize a schema.
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

  // `shallowMutableClone()` gives a mutable top-level object whose
  // bound children are deep-frozen -- cloning any mutable ones rather than
  // freezing the `schema`/`overrides` inputs in place -- so the subsequent
  // `toDeepFrozenSchema(result, true)` only has to seal the (owned) top.
  const result = shallowMutableClone(
    { ...schema, ...overrides } as FabricValue,
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
 * Common shape of the two canonical-selector maps. Its key type spans both
 * maps' keys, so a single variable selected between the object `WeakMap` and the
 * primitive `Map` accepts the un-narrowed interned schema as a key — without
 * TypeScript collapsing the two maps' key types to `never` (which is what a bare
 * `WeakMap | Map` union does).
 */
type CanonicalSelectorMap = {
  get(
    key: JSONSchema | undefined,
  ): Map<string, WeakRef<SchemaPathSelector>> | undefined;
  set(
    key: JSONSchema | undefined,
    value: Map<string, WeakRef<SchemaPathSelector>>,
  ): unknown;
};

/**
 * Canonical selector instances per (interned schema identity, path content).
 * A `SchemaPathSelector` is just `{ path, schema? }`, so structurally-equal
 * selectors can safely collapse to ONE frozen instance. That makes the
 * selector WRAPPER identity stable across repeat constructions — without it,
 * every freshly built selector misses entry-level identity caches
 * (`hashOf()`'s frozen-object WeakMap, `MapSetStringToPathSelectors`'s
 * hashing key fn, cycle trackers) and re-walks the embedded schema, which CPU
 * profiles showed as a dominant remount cost.
 *
 * Inner values are `WeakRef`s: a selector held strongly here would strongly
 * reference its schema — the outer `WeakMap` key — pinning both forever.
 * Dead refs are dropped lazily on lookup.
 *
 * As a `WeakMap`, this can only map from GC-able objects, so {@link
 * #canonicalSelectorsByPrimitiveSchema} handles primitives.
 */
const canonicalSelectorsByObjectSchema = new WeakMap<
  object,
  Map<string, WeakRef<SchemaPathSelector>>
>();

/**
 * Like {@link #canonicalSelectorsByObjectSchema}, except for primitive-valued schemas
 * including the "schema" `undefined`.
 */
const canonicalSelectorsByPrimitiveSchema = new Map<
  boolean | undefined,
  Map<string, WeakRef<SchemaPathSelector>>
>();

/**
 * Path-key strings per (frozen) path array identity. `internPathSelector()`
 * computes the key on EVERY call -- including idempotent re-interning of an
 * already-canonical selector, the common repeat case -- and that string build
 * showed up with >100ms self time in remount profiles. Canonical selectors
 * carry frozen, identity-stable path arrays, so a `WeakMap` hits.
 */
const selectorPathKeyCache = new WeakMap<readonly string[], string>();

/**
 * Injective string key for a path: each component is length-prefixed, so a
 * component containing the separator cannot collide with a differently-split
 * path.
 */
const selectorPathKey = (path: readonly string[]): string => {
  if (path.length === 0) return "";
  const cached = selectorPathKeyCache.get(path);
  if (cached !== undefined) return cached;
  let key = "";
  for (const part of path) key += `${part.length}:${part}`;
  if (Object.isFrozen(path)) {
    selectorPathKeyCache.set(path, key);
  }
  return key;
};

/**
 * Sweep threshold for a per-schema path map: schemas that never die -- interned
 * canonical schemas, primitive schemas, or `undefined` (no schama) -- would
 * otherwise accumulate `pathKey -> dead WeakRef` entries forever, since the
 * lazy cleanup below only fires when the exact same path is looked up again.
 * Sweeping on insert once the map is large bounds growth to live selectors
 * (plus the threshold).
 */
const SELECTOR_CACHE_SWEEP_THRESHOLD = 2048;

/**
 * Returns a deep-frozen `SchemaPathSelector` whose `schema` (if any) is the
 * canonical interned instance and whose `path` array is frozen.
 *
 * Usually the input reference itself is canonicalized in place — its `schema`
 * replaced with the interned instance if needed, then it and its `path` frozen
 * — and returned. The one exception: when the input is **already frozen** and
 * its `schema` is not the canonical interned instance, the schema cannot be
 * written back, so a new deep-frozen selector is allocated and returned.
 * Therefore the result is NOT guaranteed to be `===` to the input. (It is `===`
 * when the input is mutable _and_ there is no already-interned equivalent.)
 *
 * Idempotent: re-interning a result returns that same result
 * (`internPathSelector(internPathSelector(x)) === internPathSelector(x)`),
 * since a returned selector's `schema` is already canonical.
 *
 * Exists so that callers who feed selectors into `MapSetStringToPathSelectors`
 * (or any other cache keyed on `hashStringOf()` of a selector) can hand in an
 * already-interned, deep-frozen selector. That satisfies the `isDeepFrozen()`
 * guard internal to `hashOf()` and lets its `WeakMap` cache retain its hash
 * across repeat calls.
 */
export function internPathSelector(
  selector: SchemaPathSelector,
): SchemaPathSelector {
  const { path, schema } = selector;

  const interned = schema === undefined ? undefined : internSchema(schema);
  const topMap: CanonicalSelectorMap = (typeof interned === "object")
    ? canonicalSelectorsByObjectSchema
    : canonicalSelectorsByPrimitiveSchema;
  let byPath = topMap.get(interned);
  if (byPath === undefined) {
    byPath = new Map();
    topMap.set(interned, byPath);
  }

  const pathK = selectorPathKey(path);
  const existingRef = byPath.get(pathK);
  if (existingRef !== undefined) {
    const existing = existingRef.deref();
    if (existing !== undefined) {
      // Preserve the pre-cache contract for callers that keep using their
      // input object: a mutable input is still canonicalized and frozen in
      // place even when a structurally-equal canonical instance exists.
      if (existing !== selector && !Object.isFrozen(selector)) {
        if (interned !== schema) {
          selector.schema = interned;
        }
        Object.freeze(path);
        Object.freeze(selector);
      }
      return existing;
    }
    byPath.delete(pathK);
  }

  if (byPath.size >= SELECTOR_CACHE_SWEEP_THRESHOLD) {
    for (const [k, ref] of byPath) {
      if (ref.deref() === undefined) byPath.delete(k);
    }
  }

  // First instance with this content becomes the canonical one. Keep the
  // pre-existing in-place behavior: swap in the canonical schema and freeze
  // when the input is mutable; allocate only when the input is frozen with a
  // non-canonical schema.
  let canonical: SchemaPathSelector;
  if (interned !== schema && Object.isFrozen(selector)) {
    canonical = Object.freeze({
      path: Object.freeze(path),
      schema: interned,
    }) as SchemaPathSelector;
  } else {
    if (interned !== schema) {
      selector.schema = interned;
    }
    Object.freeze(path);
    canonical = Object.freeze(selector);
  }
  byPath.set(pathK, new WeakRef(canonical));
  return canonical;
}

/**
 * Canonical "reject everything at the root" path selector. Used by sites
 * that want to record a doc dependency (or normalize a `{ schema: false,
 * ... }` input) without actually traversing into it.
 *
 * Frozen at module load, but its `schema: false` member is NOT routed
 * through `internSchema()` here (because doing so during `schema-utils.ts`'s
 * module-load would reach into a not-yet-initialized `schema-hash.ts`
 * due to the pre-existing circular import between the two modules). The
 * boolean-schema intern path uses prefab singletons anyway, so
 * lazy-interning the `false` on first real selector use is
 * behaviorally equivalent to interning here.
 */
export const REJECTING_SELECTOR: SchemaPathSelector = Object.freeze({
  path: Object.freeze([]) as readonly string[],
  schema: false as const,
});

/**
 * Canonical "accept the full value" path selector. `SchemaPathSelector`s
 * are relative to the doc root, so to look at the value of the doc the
 * path needs to have `"value"` in it.
 *
 * Frozen at module load; like `REJECTING_SELECTOR`, the boolean
 * `schema: true` member is not routed through `internSchema()` here
 * (same circular-import reason — see `REJECTING_SELECTOR` doc comment).
 */
export const DEFAULT_SELECTOR: SchemaPathSelector = Object.freeze({
  path: Object.freeze(["value"]) as readonly string[],
  schema: true as const,
});

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
