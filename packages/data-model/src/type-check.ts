/**
 * The predicates deciding whether a value belongs to the `FabricValue` type,
 * and the narrowings that ask a shape question about one that already does.
 *
 * Membership turns on inertness: a `FabricValue` is data, so anything that is
 * live code is refused -- a function, an accessor-backed property, the
 * prototype of an `Array` subclass, a symbol that was never registry-interned.
 * Frozen-ness is a separate question and deliberately not asked here, so a
 * structurally-valid unfrozen value is a member.
 *
 * The narrowings are looser than membership on purpose. They are asked of a
 * value whose type already claims to be a `FabricValue`, and answer only
 * whether it may be read by name; where one accepts something membership
 * refuses, the difference is stated on that narrowing rather than here.
 */

import { isInertArray } from "@commonfabric/utils/arrays";
import {
  constructorOfObject,
  isInertPlainObject,
} from "@commonfabric/utils/objects";
import {
  isPlainContainer,
  isPlainObject,
  unsafeObjectKeyIn,
} from "@commonfabric/utils/types";

import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricNativeObject,
  type FabricPlainObject,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import { VALUE_TAGS } from "./VALUE_TAGS.ts";
import { tagFromNativeBuiltinClass } from "./tagFromNativeBuiltinClass.ts";
import { BaseFabricInstance } from "./fabric-bases/BaseFabricInstance.ts";
import { BaseFabricPrimitive } from "./fabric-bases/BaseFabricPrimitive.ts";

/**
 * Indicates whether the value is a `FabricValue`, accepting
 * `FabricSpecialObject`s (both `FabricInstance` and `FabricPrimitive`),
 * `undefined`, and arrays with `undefined` elements or sparse holes -- in
 * addition to the base fabric types (`null`, `boolean`, `number`, `string`,
 * plain objects, dense arrays). An array must be a direct `Array` instance; a
 * subclass instance is not a `FabricValue`.
 *
 * This function is a TypeScript type guard for `FabricValueLayer`.
 */
export function isValidFabricValueLayer(
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
      // Registry-interned symbols are valid `FabricValue`s; unique ones are
      // not.
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
 * question, see `isValidDeepFrozenFabricValue()`. A `FabricInstance` is a
 * member by type (it is a `FabricSpecialObject`); this does not recurse into
 * its private interior, whose contents are `FabricValue`s by the instance's
 * construction contract and are reachable only via frozen-semantic protocols
 * that a membership check must not invoke.
 *
 * Contrast the shallow, single-level sibling `isValidFabricValueLayer()` and
 * `isValidFabricConvertibleValue()` (which additionally accepts native values
 * *convertible* to fabric form).
 *
 * This is the admission test the encoding path's input contract is written
 * against: a value this accepts encodes, and one it does not gets whatever
 * best-effort handling costs correct input nothing. See
 * `BaseCodecEngine.encode()`.
 */
export function isValidFabricValue(value: unknown): value is FabricValue {
  // Fast leaf paths first, so a function or a primitive returns without
  // allocating the cycle-tracking set or the recursion closure below.
  if (typeof value === "function") {
    return false;
  } else if (typeof value === "symbol") {
    // Only registry-interned symbols are `FabricValue`s; unique (uninterned)
    // symbols are not portable across realms and are rejected, matching
    // `isValidFabricValueLayer()`.
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
      // A `FabricInstance` is a `FabricValue` by type. Its logical contents
      // are private and reachable only through the frozen-semantic
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
 * Indicates whether the value is a `FabricPlainObject`: both a `FabricValue`
 * (`isValidFabricValue()`) and a plain object, meaning its prototype is
 * `Object.prototype` and its every property value is a `FabricValue` in turn.
 *
 * This is a *membership* check asked of an `unknown`, which makes it strictly
 * narrower at runtime than the narrowing `isFabricPlainObject()`: that one is
 * asked of a value already typed as a `FabricValue`, and accepts a
 * null-prototype object, which membership refuses.
 */
export function isValidFabricPlainObject(
  value: unknown,
): value is FabricPlainObject {
  return isValidFabricValue(value) && isFabricPlainObject(value);
}

/**
 * Narrows to the container arms of `FabricValue` -- a plain object, an array,
 * or a `FabricInstance` -- that is, the values that hold other `FabricValue`s.
 *
 * Contrast `isFabricObjectOrArray()`, which is one arm wider: it also accepts a
 * `FabricPrimitive`, an object that is not a container. The two are not
 * interchangeable where the answer decides a descent.
 */
export function isFabricContainerValue(
  value: FabricValue,
): value is FabricContainerValue {
  return isPlainContainer(value) || value instanceof FabricInstance;
}

/**
 * Narrows to the two *plain* container arms of `FabricValue` -- an array or a
 * plain object -- the values whose contents are reachable by index or property
 * name. This is the question to ask before addressing into a value by key.
 *
 * Contrast `isFabricContainerValue()`, which is one arm wider: a
 * `FabricInstance` is a container, but it holds its contents privately, so a
 * key means nothing against one. Assigning through a value this rejects and
 * that one accepts puts an own property on an instance, which is a state no
 * `FabricInstance` has.
 */
export function isFabricPlainContainer(
  value: FabricValue,
): value is FabricArray | FabricPlainObject {
  return isPlainContainer(value);
}

/**
 * Indicates whether a `FabricValue` is a plain object, an array, or a
 * `FabricSpecialObject` -- everything a `typeof value === "object"` test
 * accepts, minus `null`. The name states the array case because "object" alone
 * reads as excluding it.
 *
 * The runtime behavior matches a bare `isObjectOrArray()` exactly. The
 * difference is static: `isObjectOrArray()` narrows to `Record<string,
 * unknown>`, which discards the fact that the value is a `FabricValue` -- so a
 * guarded value can no longer be handed to a `FabricValue` API. This keeps that
 * half.
 *
 * Contrast `isFabricPlainObject()`, which is strictly narrower at RUNTIME: it
 * accepts only plain objects, rejecting arrays and `FabricSpecialObject`s. The
 * two are not interchangeable. Between them sit
 * `isFabricContainerValue()`, which rejects only the `FabricPrimitive` half of
 * `FabricSpecialObject`, and `isFabricPlainContainer()`, which rejects all of
 * it.
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
 * which are representable as a `FabricPlainObject`. Unlike a bare
 * `isObjectOrArray()` check, it preserves the value type —
 * `FabricPlainObject`'s string index of `FabricValue` keeps an indexed value
 * typed as a `FabricValue`.
 *
 * This asks a shape question -- "may I read this by property name?" -- of a
 * value the type already says is a `FabricValue`, and a null-prototype object
 * answers yes as readily as any other record. That makes it deliberately looser
 * than membership: a `FabricPlainObject` is `Object.prototype`-rooted, so
 * `isValidFabricValue()` refuses the null-prototype object this accepts. The
 * looseness costs nothing, the input being out of contract either way, and it
 * keeps callers holding un-validated values from losing a reader they can use.
 * For the membership question asked of an `unknown`, see
 * `isValidFabricPlainObject()`.
 */
export function isFabricPlainObject(
  value: FabricValue,
): value is FabricPlainObject {
  return isPlainObject(value);
}

/**
 * Returns `true` if the value is a `FabricNativeObject`: one of the
 * "wild-west" native JS instances that the conversion layer wraps into a
 * `FabricNativeWrapper` subclass, a `FabricPrimitive`, or a `FabricInstance`.
 *
 * Arrays, plain objects, and system-defined `FabricPrimitive`s are _not_
 * `FabricNativeObject`s -- they have their own handling paths in the
 * conversion layer.
 *
 * This function is a TypeScript type guard for `FabricNativeObject`.
 */
export function isValidFabricNativeObject(
  value: unknown,
): value is FabricNativeObject {
  if (value === null || typeof value !== "object") return false;

  // Arrays first, and unconditionally, exactly as the full dispatch does it.
  // An array's class is USUALLY `Array`, whose tag is not one of the six
  // below -- but a prototype can be re-pointed, and an array wearing
  // `Date.prototype` would otherwise be reported as a convertible `Date`.
  // `Array.isArray()` sees through that, and through a subclass and a severed
  // prototype besides, which is why the array rule alone decides what an array
  // may be.
  if (Array.isArray(value)) return false;

  const ctor = constructorOfObject(value);
  const tag = (ctor !== undefined) ? tagFromNativeBuiltinClass(ctor) : null;

  switch (tag ?? (Error.isError(value) ? VALUE_TAGS.Error : null)) {
    case VALUE_TAGS.Error:
    case VALUE_TAGS.Map:
    case VALUE_TAGS.Set:
    case VALUE_TAGS.Date:
    case VALUE_TAGS.Uint8Array:
    case VALUE_TAGS.RegExp:
      return true;
    default:
      return false;
  }
}
