// Re-export everything from `interface.ts` so that `fabric-value` remains the
// canonical public surface for all type declarations and the `FabricInstance`
// base class.
export {
  type FabricArray,
  FabricInstance,
  type FabricNativeObject,
  type FabricObject,
  FabricPrimitive,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";

export {
  cloneForMutation,
  CloneForMutationError,
  type CloneForMutationErrorKind,
  type CloneForMutationOptions,
  type CloneForMutationResult,
  cloneIfNecessary,
  type CloneOptions,
  cloneWithoutValueAtPath,
  cloneWithValueAtPath,
  shallowMutableClone,
} from "./value-clone.ts";

export { isFabricValueLayer } from "./type-check.ts";

export {
  fabricFromNativeValue,
  isFabricCompatible,
  nativeFromFabricValue,
  shallowFabricFromNativeValue,
} from "./native-conversion.ts";

import { isRecord } from "@commonfabric/utils/types";
import { FabricSpecialObject } from "./interface.ts";
import { hashStringOf } from "./value-hash.ts";

/**
 * Compares two `FabricValue`s for logical (content) equality.
 *
 * This is the `data-model`-aware equality the storage layer's no-op /
 * change-detection gates need, and the fix for what `deepEqual()` gets wrong:
 * any `FabricSpecialObject` (`FabricPrimitive` leaves like `FabricBytes` /
 * `FabricRegExp` / `FabricEpoch*` / `FabricHash`, and `FabricInstance`
 * wrappers) keeps its state in private `#fields` with zero enumerable
 * own-properties, so `deepEqual()` conflates every distinct same-class instance
 * as equal (the CT-1770 bug). Here such values are compared by canonical
 * content hash instead.
 *
 * Everything else is the ordinary structural recursion over the JSON-shaped
 * `FabricValue` space — plain objects, arrays (including sparse holes vs a
 * stored `undefined`), and primitives via `Object.is` — recursing through every
 * node so a special object nested arbitrarily deep is still hashed. (Unlike
 * `deepEqual()` it does not handle non-`Fabric` class instances or named
 * properties on arrays: those are not representable as `FabricValue`s.)
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  // Either side a special object: compare by canonical content hash, the
  // logical identity for every `FabricValue`. (A special object and a plain
  // value can never share a hash — distinct type tags — so this also correctly
  // reports them unequal.)
  if (a instanceof FabricSpecialObject || b instanceof FabricSpecialObject) {
    return hashStringOf(a) === hashStringOf(b);
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray || Array.isArray(b)) {
    if (!aIsArray || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      // A hole and a stored `undefined` are different states.
      if ((i in a) !== (i in b)) return false;
      if (i in a && !valueEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (!(isRecord(a) && isRecord(b))) return false;

  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    // A present `undefined` and an absent key are different states, so require
    // the key on `b` (not just an equal looked-up value).
    if (!Object.hasOwn(b, key)) return false;
    if (!valueEqual(a[key], b[key])) return false;
  }
  return true;
}
