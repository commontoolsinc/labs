// Re-export everything from `interface.ts` so that `fabric-value` remains the
// canonical public surface for all type declarations and the `FabricInstance`
// base class.
export {
  DECONSTRUCT,
  type FabricArray,
  type FabricClass,
  FabricInstance,
  type FabricNativeObject,
  type FabricObject,
  FabricPrimitive,
  type FabricValue,
  type FabricValueConverter,
  type FabricValueLayer,
  RECONSTRUCT,
  type ReconstructionContext,
  type SerializationContext,
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

import type {
  FabricNativeObject,
  FabricValue,
  FabricValueLayer,
} from "./interface.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  fabricFromNativeValueModern,
  isFabricCompatibleModern,
  isFabricValueModern,
  nativeFromFabricValueModern,
  shallowFabricFromNativeValueModern,
} from "./fabric-value-modern.ts";

/**
 * Converts a native JS value to fabric form (deep, recursive).
 *
 * @param freeze - When `true` (default), deep-freezes the result.
 */
export function fabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValue {
  return fabricFromNativeValueModern(value, freeze);
}

/**
 * Recursively walks a `FabricValue` tree, unwrapping any
 * `FabricNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Non-native `FabricInstance` values (`Cell`, `Stream`,
 * `UnknownValue`, etc.) pass through as-is.
 *
 * @param frozen - When `true` (default), deep-freezes the result.
 */
export function nativeFromFabricValue(
  value: FabricValue,
  frozen = true,
): FabricValue | FabricNativeObject {
  return nativeFromFabricValueModern(value, frozen);
}

/**
 * Determines if the given value is considered "fabric-compatible" by the system per se
 * (without invoking any conversions such as `toJSON()`). This function does
 * not recursively validate nested values in arrays or objects.
 *
 * @param value - The value to check.
 * @returns `true` if the value is fabric-compatible per se, `false` otherwise.
 *
 * This function is a TypeScript type guard for `FabricValueLayer`.
 */
export function isFabricValue(
  value: unknown,
): value is FabricValueLayer {
  return isFabricValueModern(value);
}

/**
 * Returns `true` if `fabricFromNativeValue()` would succeed on the value.
 * Checks whether the value is a `FabricValue`, a `FabricNativeObject`,
 * or a deep tree thereof.
 *
 * @param value - The value to check.
 * @returns `true` if the value can be stored, `false` otherwise.
 *
 * This function is a TypeScript type guard for `FabricValue | FabricNativeObject`.
 */
export function isFabricCompatible(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return isFabricCompatibleModern(value);
}

/**
 * Converts a value to fabric form without recursing into nested values.
 * JSON-encodable values pass through as-is. Functions and instances are
 * converted via `toJSON()` if available.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array.
 * @returns The fabric value (original or converted).
 * @throws Error if the value can't be converted to fabric form.
 */
export function shallowFabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValueLayer {
  return shallowFabricFromNativeValueModern(value, freeze);
}

/**
 * Compares two fabric values for equality.
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  // TODO(danfuzz): This needs to be a `data-model`-aware function.
  // `deepEqual()` is not that.
  return deepEqual(a, b);
}
