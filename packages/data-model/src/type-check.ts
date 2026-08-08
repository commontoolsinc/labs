import { isInertArray } from "@commonfabric/utils/arrays";
import { isInertPlainObject } from "@commonfabric/utils/objects";
import { isPlainObject, unsafeObjectKeyIn } from "@commonfabric/utils/types";

import {
  type FabricPlainObject,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import { BaseFabricInstance } from "./fabric-instances/BaseFabricInstance.ts";
import { BaseFabricPrimitive } from "./fabric-primitives/BaseFabricPrimitive.ts";

/**
 * Indicates whether the value is a fabric value, accepting
 * `FabricSpecialObject`s (both `FabricInstance` and `FabricPrimitive`),
 * `undefined`, and arrays with `undefined` elements or sparse holes
 * -- in addition to the base fabric types (`null`, `boolean`, `number`,
 * `string`, plain objects, dense arrays). An array must be a direct `Array`
 * instance; a subclass instance is not a fabric value.
 *
 * This function is a TypeScript type guard for `FabricValueLayer`.
 */
export function isFabricValueLayer(
  value: unknown,
): value is FabricValueLayer {
  switch (typeof value) {
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "undefined": {
      return true;
    }

    case "object": {
      if (value === null) {
        return true;
      }
      // `FabricSpecialObject` -- already a valid `FabricValue`.
      if (value instanceof FabricSpecialObject) {
        return true;
      }
      if (Array.isArray(value)) {
        // Arrays with `undefined` elements and sparse holes are accepted, but
        // not arrays carrying named or symbol-keyed properties, nor an
        // accessor-backed index, nor an indirect instance such as an `Array`
        // subclass (all live code rather than inert data).
        return isInertArray(value);
      }
      // Plain objects are accepted; class instances are not (except
      // `FabricSpecialObject`, handled above). `FabricPlainObject` is keyed by
      // `string`, so a symbol key has no representation either, and neither
      // does a non-enumerable string key; an accessor-backed property is live
      // code rather than inert data. The names this runtime reserves are a
      // separate question from inertness -- see `unsafeObjectKeyIn()`.
      return isInertPlainObject(value) &&
        (unsafeObjectKeyIn(value) === undefined);
    }

    case "symbol": {
      // Registry-interned symbols are valid fabric values; unique ones are not.
      return Symbol.keyFor(value) !== undefined;
    }

    case "function":
    default: {
      return false;
    }
  }
}

/**
 * Indicates whether the value is a `FabricValue` -- a recursive check of exact
 * structural membership in the `FabricValue` type, independent of frozen-ness.
 *
 * Returns `true` for any scalar (`null`, `undefined`, `boolean`, `number` --
 * including `-0`, `NaN`, and `±Infinity` -- `string`, `bigint`, and
 * registry-interned (`Symbol.for(...)`) symbols), any `FabricInstance` or
 * `FabricPrimitive`, a direct `Array` instance holding `FabricValue`s with no
 * named or symbol-keyed properties, `length` aside (sparse holes allowed), or a
 * plain object whose values are all `FabricValue`s. Returns `false` for a
 * `function` or a unique (uninterned) symbol -- whether the value itself or
 * reached anywhere within it -- for an accessor-backed (getter/setter) property
 * anywhere, plain-object keyed or array-indexed alike, which makes its
 * container non-inert, for an `Array` subclass instance or other
 * indirectly-rooted array, whose prototype is live code the same way an
 * accessor is, and for any other class instance (`Date`, `Map`, ...) not
 * representable as a `FabricValue`. Handles circular references.
 *
 * This is a *membership* check, not a frozen-ness check: a structurally-valid
 * but unfrozen object or array is still a `FabricValue`. For the deep-frozen
 * question, see `isDeepFrozenFabricValue()`. A fabric instance is a member by
 * type (it is a `FabricSpecialObject`); this does not recurse into its private
 * interior, whose contents are `FabricValue`s by the instance's construction
 * contract and are reachable only via frozen-semantic protocols that a
 * membership check must not invoke.
 *
 * Contrast the shallow, single-level sibling `isFabricValueLayer()` and
 * `isFabricCompatible()` (which additionally accepts native values
 * *convertible* to fabric form).
 */
export function isFabricValue(value: unknown): value is FabricValue {
  // Fast leaf paths first, so a function or a primitive answers without
  // allocating the cycle-tracking set or the recursion closure below.
  if (typeof value === "function") {
    return false;
  } else if (typeof value === "symbol") {
    // Only registry-interned symbols are `FabricValue`s; unique (uninterned)
    // symbols are not portable across realms and are rejected, matching
    // `isFabricValueLayer()`.
    return Symbol.keyFor(value) !== undefined;
  } else if (value === null || typeof value !== "object") {
    // A non-function, non-symbol primitive -- a direct `FabricValue` member.
    return true;
  }

  // We have object structure to walk. Allocate the cycle-tracking set and build
  // the recursion callback once here, reusing the same closure at every layer.
  const seen = new Set<object>();
  const check = (item: unknown): boolean => {
    if (typeof item === "function") return false;
    if (typeof item === "symbol") return Symbol.keyFor(item) !== undefined;
    if (item === null || typeof item !== "object") {
      // A non-function, non-symbol primitive.
      return true;
    } else if (seen.has(item)) {
      // Already being validated higher in the recursion; treat as a member for
      // the rest of this walk (a cycle back to an in-progress value).
      return true;
    }

    seen.add(item);

    if (BaseFabricPrimitive.isInstance(item)) {
      // A `FabricPrimitive` is a `FabricValue` with no outbound references.
      return true;
    } else if (BaseFabricInstance.isInstance(item)) {
      // A fabric instance is a `FabricValue` by type. Its logical contents are
      // private and reachable only through the frozen-semantic
      // `[IS_DEEP_FROZEN]`/`[DEEP_FREEZE]` protocols, which a pure membership
      // check must not invoke; the instance's construction contract already
      // guarantees its interior holds `FabricValue`s. So membership trusts the
      // type and does not recurse.
      return true;
    } else if (Array.isArray(item)) {
      // Arrays with named (non-index) or symbol-keyed properties have no
      // fabric representation; an accessor-backed index is live code rather
      // than inert data, as is the prototype of an indirect instance such as
      // an `Array` subclass.
      if (!isInertArray(item)) return false;
      for (let i = 0; i < item.length; i++) {
        if (!(i in item)) continue; // sparse hole
        if (!check(item[i])) return false;
      }
      return true;
    } else if (isPlainObject(item)) {
      // Symbol-keyed and non-enumerable string-keyed properties have no fabric
      // representation, the same as an array's non-index properties; an
      // accessor-backed property is live code rather than inert data. The
      // names this runtime reserves are a separate question from inertness --
      // see `unsafeObjectKeyIn()`.
      if (!isInertPlainObject(item)) return false;
      if (unsafeObjectKeyIn(item) !== undefined) return false;
      for (const key of Object.keys(item)) {
        if (!check(item[key])) return false;
      }
      return true;
    } else {
      // An instance of a class not covered by the `FabricValue` type.
      return false;
    }
  };

  return check(value);
}

/**
 * Indicates whether a fabric value is a plain object, an array, or a
 * `FabricSpecialObject` -- everything a `typeof value === "object"` test
 * accepts, minus `null`. The name spells out the array case because "object"
 * alone reads as excluding it.
 *
 * The runtime behavior matches a bare `isRecord()` exactly. The difference is
 * static: `isRecord()` narrows to `Record<string | number | symbol, unknown>`,
 * which discards the fact that the value is a `FabricValue` -- so a guarded
 * value can no longer be handed to a `FabricValue` API. This keeps that half.
 *
 * Contrast `isFabricPlainObject()`, which is strictly narrower at RUNTIME: it
 * accepts only plain objects, rejecting arrays and `FabricSpecialObject`s. The
 * two are not interchangeable.
 */
export function isFabricObjectOrArray(
  value: FabricValue,
): value is FabricValue & object {
  return typeof value === "object" && value !== null;
}

/**
 * Narrows to the plain-record arm of `FabricValue` (`FabricPlainObject`): an
 * object whose prototype is `Object.prototype` or `null`. This rejects arrays,
 * `FabricSpecialObject`s, and other class instances (`Date`, `Map`, …), none of
 * which are representable as a `FabricPlainObject`. Unlike a bare `isRecord()`
 * check, it preserves the value type — `FabricPlainObject`'s string index of
 * `FabricValue` keeps an indexed value typed as a `FabricValue`.
 *
 * This asks a shape question -- "may I read this by property name?" -- of a
 * value the type already says is a `FabricValue`, and a null-prototype object
 * answers yes as readily as any other record. That makes it deliberately looser
 * than membership: a `FabricPlainObject` is `Object.prototype`-rooted, so
 * `isFabricValue()` refuses the null-prototype object this accepts. The
 * looseness costs nothing, the input being out of contract either way, and it
 * keeps callers holding un-validated values from losing a reader they can use.
 */
export function isFabricPlainObject(
  value: FabricValue,
): value is FabricPlainObject {
  return isPlainObject(value);
}
