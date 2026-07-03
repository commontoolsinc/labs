import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";
import { type Immutable, isPlainObject } from "@commonfabric/utils/types";

import {
  type FabricPlainObject,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";

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
export function isFabricPlainObject(value: unknown): value is FabricPlainObject;
export function isFabricPlainObject(value: unknown): boolean {
  return isPlainObject(value);
}
