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
 * This is the `data-model`-aware equality that the storage layer's no-op /
 * change-detection gates need. It mirrors `deepEqual()`'s structural recursion
 * for plain objects and arrays (including its hole-vs-stored-`undefined`
 * handling), but defers to canonical content hashing for any
 * `FabricSpecialObject` (`FabricPrimitive` leaves like `FabricBytes` /
 * `FabricRegExp` / `FabricEpoch*` / `FabricHash`, and `FabricInstance`
 * wrappers). Those carry their state in private `#fields` with zero enumerable
 * own-properties, so `deepEqual()` conflates every distinct same-class instance
 * as equal — the CT-1770 bug. Hashing sees their real contents.
 *
 * Plain containers may *contain* special objects nested arbitrarily deep, so
 * the recursion checks every node; the hash fast-path only fires once a special
 * object is actually reached, leaving the common all-plain-data case on the
 * same fast, short-circuiting path as `deepEqual()`.
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

  if (!(isRecord(a) && isRecord(b))) return false;
  if (a.constructor !== b.constructor) return false;

  const keysA = Object.keys(a);
  const keysALength = keysA.length;
  if (keysALength !== Object.keys(b).length) return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (!(aIsArray || bIsArray)) {
    return checkSpecificProps(a, b, keysA);
  }
  if (!(aIsArray && bIsArray)) return false;

  const lengthA = (a as unknown[]).length;
  if (lengthA !== (b as unknown[]).length) return false;

  let indexCount = 0;
  for (let i = 0; i < lengthA; i++) {
    const aValue = (a as unknown[])[i];
    const bValue = (b as unknown[])[i];
    indexCount++;
    if (!valueEqual(aValue, bValue)) return false;
    if (aValue === undefined) {
      const aHasIt = Object.hasOwn(a, i);
      const bHasIt = Object.hasOwn(b, i);
      if (aHasIt !== bHasIt) return false;
      if (!aHasIt && !bHasIt) indexCount--;
    }
  }

  if (indexCount === keysALength) return true;
  return checkSpecificProps(a, b, keysA.slice(indexCount));
}

function checkSpecificProps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keysToCheck: string[],
): boolean {
  for (const key of keysToCheck) {
    const aValue = a[key];
    if (!valueEqual(aValue, b[key])) return false;
    if (aValue === undefined && !Object.hasOwn(b, key)) return false;
  }
  return true;
}
