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
import {
  fabricFromNativeValueLegacy,
  isFabricCompatibleLegacy,
  isFabricValueLegacy,
  shallowFabricFromNativeValueLegacy,
} from "./fabric-value-legacy.ts";
export {
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
} from "./array-utils.ts";

//
// Configuration flags
//

/**
 * Module-level flag for modern data model mode, set by the `Runtime`
 * constructor via `setDataModelConfig()`. When enabled, fabric value
 * functions use the extended type system (`bigint`, `Map`, `Set`,
 * `Uint8Array`, `Date`, etc.).
 */
let modernDataModelEnabled = true;

/**
 * Activates or deactivates modern data model mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.modernDataModel` into the
 * memory layer.
 */
export function setDataModelConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    modernDataModelEnabled = enabled ?? false;
  }
}

/** Returns whether modern data model mode is currently enabled. */
export function getDataModelConfig(): boolean {
  return modernDataModelEnabled;
}

/**
 * Restores modern data model mode to its default (enabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetDataModelConfig(): void {
  modernDataModelEnabled = true;
}

//
// Flag-dispatched functions
//

/**
 * Converts a native JS value to fabric form (deep, recursive).
 *
 * Flag OFF (legacy): performs deep conversion via `fabricFromNativeValueLegacy()`.
 * Flag ON (modern): wraps native types (`Error`, `Date`, `RegExp`, etc.) into
 * fabric wrappers and deep-freezes via `fabricFromNativeValueModern()`.
 *
 * @param freeze - When `true` (default), deep-freezes the result. Only
 *   applies when `modernDataModel` is ON; the legacy path does not
 *   freeze.
 */
export function fabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValue {
  return modernDataModelEnabled
    ? fabricFromNativeValueModern(value, freeze)
    : fabricFromNativeValueLegacy(value);
}

/**
 * Recursively walks a `FabricValue` tree, unwrapping any
 * `FabricNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Non-native `FabricInstance` values (`Cell`, `Stream`,
 * `UnknownValue`, etc.) pass through as-is.
 *
 * Flag OFF (legacy): identity passthrough (legacy values contain no
 * `FabricNativeWrapper` instances). Flag ON (modern): delegates to
 * `nativeFromFabricValueModern()`.
 *
 * @param frozen - When `true` (default), deep-freezes the result. Only
 *   applies when `modernDataModel` is ON; the legacy path is a
 *   passthrough regardless.
 */
export function nativeFromFabricValue(
  value: FabricValue,
  frozen = true,
): FabricValue {
  return modernDataModelEnabled
    ? nativeFromFabricValueModern(value, frozen) as FabricValue
    : value;
}

/**
 * Determines if the given value is considered "fabric-compatible" by the system per se
 * (without invoking any conversions such as `toJSON()`). This function does
 * not recursively validate nested values in arrays or objects.
 *
 * Flag OFF (legacy): fabric values are JSON-encodable values plus
 * `undefined`. Flag ON (modern): delegates to `isFabricValueModern()` which
 * accepts the extended type system.
 *
 * @param value - The value to check.
 * @returns `true` if the value is fabric-compatible per se, `false` otherwise.
 *
 * This function is a TypeScript type guard for `FabricValueLayer`.
 */
export function isFabricValue(
  value: unknown,
): value is FabricValueLayer {
  return modernDataModelEnabled
    ? isFabricValueModern(value)
    : isFabricValueLegacy(value);
}

/**
 * Returns `true` if `fabricFromNativeValue()` would succeed on the value.
 * Checks whether the value is a `FabricValue`, a `FabricNativeObject`,
 * or a deep tree thereof.
 *
 * Flag OFF (legacy): equivalent to `isFabricValue()` (non-recursive).
 * Flag ON (modern): delegates to `isFabricCompatibleModern()` which recursively
 * validates nested values.
 *
 * @param value - The value to check.
 * @returns `true` if the value can be stored, `false` otherwise.
 *
 * This function is a TypeScript type guard for `FabricValue | FabricNativeObject`.
 */
export function isFabricCompatible(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return modernDataModelEnabled
    ? isFabricCompatibleModern(value)
    : isFabricCompatibleLegacy(value);
}

/**
 * Converts a value to fabric form without recursing into nested values.
 * JSON-encodable values pass through as-is. Functions and instances are
 * converted via `toJSON()` if available.
 *
 * Flag OFF (legacy): JSON-only type system. Flag ON (modern): delegates to
 * `shallowFabricFromNativeValueModern()` which handles the extended type system.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array. Only applies when `modernDataModel` is ON.
 * @returns The fabric value (original or converted).
 * @throws Error if the value can't be converted to fabric form.
 */
export function shallowFabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValueLayer {
  return modernDataModelEnabled
    ? shallowFabricFromNativeValueModern(value, freeze)
    : shallowFabricFromNativeValueLegacy(value);
}

/**
 * Compares two fabric values for equality.
 *
 * Flag OFF (legacy): uses `JSON.stringify()` comparison, matching the behavior of
 * the original `JSON.parse(JSON.stringify(...))` round-trip (strips `undefined`,
 * coerces `NaN` to `null`, etc.).
 *
 * Flag ON (modern): uses deep structural equality that correctly handles
 * undefined, sparse arrays, and other extended types.
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  return modernDataModelEnabled
    ? deepEqual(a, b)
    : JSON.stringify(a) === JSON.stringify(b);
}
