import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";
import { type Immutable, isPlainObject } from "@commonfabric/utils/types";

import {
  type FabricPlainObject,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import { BaseFabricInstance } from "./fabric-instances/BaseFabricInstance.ts";
import { BaseFabricPrimitive } from "./fabric-primitives/BaseFabricPrimitive.ts";

/**
 * Indicates whether the value is a fabric value, accepting `FabricInstance`
 * values, `undefined`, and arrays with `undefined` elements or sparse holes
 * -- in addition to the base fabric types (`null`, `boolean`, `number`,
 * `string`, plain objects, dense arrays).
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
        // not arrays with non-index properties.
        return isArrayWithOnlyIndexProperties(value);
      }
      // Plain objects are accepted; class instances are not (except
      // `FabricInstance`, handled above).
      const proto = Object.getPrototypeOf(value);
      return proto === null || proto === Object.prototype;
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
 * Returns `true` for any scalar (`null`, `undefined`, `boolean`, `number`
 * -- including `-0`, `NaN`, and `±Infinity` -- `string`, `bigint`, `symbol`),
 * any `FabricInstance` or `FabricPrimitive`, an array of `FabricValue`s with no
 * enumerable non-index properties (sparse holes allowed), or a plain object
 * whose values are all `FabricValue`s. Returns `false` for a `function`
 * (anywhere in the graph) and for any other class instance (`Date`, `Map`, ...)
 * not representable as a `FabricValue`. Handles circular references.
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
 * `isFabricCompatible()` (which additionally accepts native values *convertible*
 * to fabric form).
 */
export function isFabricValue(value: unknown): value is FabricValue {
  // Fast leaf paths first, so a function or a primitive answers without
  // allocating the cycle-tracking set or the recursion closure below.
  if (typeof value === "function") {
    return false;
  } else if (value === null || typeof value !== "object") {
    // A non-function primitive -- a direct `FabricValue` member.
    return true;
  }

  // We have object structure to walk. Allocate the cycle-tracking set and build
  // the recursion callback once here, reusing the same closure at every layer.
  const seen = new Set<object>();
  const check = (item: unknown): boolean => {
    if (typeof item === "function") return false;
    if (item === null || typeof item !== "object") {
      // A non-function primitive.
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
      // Arrays with enumerable named (non-index) properties have no fabric
      // representation.
      if (!isArrayWithOnlyIndexProperties(item)) return false;
      for (let i = 0; i < item.length; i++) {
        if (!(i in item)) continue; // sparse hole
        if (!check(item[i])) return false;
      }
      return true;
    } else if (isPlainObject(item)) {
      const record = item as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!check(record[key])) return false;
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
 * Narrows to the plain-record arm of `FabricValue` (`FabricPlainObject`): an object
 * whose prototype is `Object.prototype` or `null`. This rejects arrays,
 * `FabricSpecialObject`s, and other class instances (`Date`, `Map`, …), none of
 * which are representable as a `FabricPlainObject`. Unlike a bare `isRecord()` check,
 * it preserves the value type — `FabricPlainObject`'s string index of `FabricValue`
 * keeps an indexed value typed as a `FabricValue`.
 */
export function isFabricPlainObject(
  value: FabricValue,
): value is FabricPlainObject;
export function isFabricPlainObject(
  value: Immutable<FabricValue>,
): value is Immutable<FabricPlainObject>;
export function isFabricPlainObject(value: unknown): boolean {
  return isPlainObject(value);
}
