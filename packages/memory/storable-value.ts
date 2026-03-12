import { deepEqual } from "@commontools/utils/deep-equal";
import type { Immutable } from "@commontools/utils/types";
import type {
  StorableNativeObject,
  StorableValue,
  StorableValueLayer,
} from "./interface.ts";
import {
  canBeStoredRich,
  cloneIfNecessaryRich,
  type CloneOptions,
  isStorableValueRich,
  shallowStorableFromNativeValueRich,
  storableFromNativeValueRich,
} from "./storable-value-modern.ts";
export type { CloneOptions } from "./storable-value-modern.ts";
import { nativeFromStorableValueRich } from "./storable-native-instances.ts";
import {
  canBeStoredLegacy,
  isStorableValueLegacy,
  shallowStorableFromNativeValueLegacy,
  storableFromNativeValueLegacy,
} from "./storable-value-legacy.ts";
export {
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
} from "./storable-value-utils.ts";

// ---------------------------------------------------------------------------
// Experimental storable value configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for experimental storable-value features gated behind
 * `RuntimeOptions.experimental`. Uses ambient (module-level) state so that
 * deep call sites can check flags without parameter threading.
 *
 * See Section 1 of the formal spec (`docs/specs/space-model-formal-spec/`).
 */
export interface ExperimentalStorableConfig {
  /** When `true`, storable value functions use the extended type system
   *  (bigint, Map, Set, Uint8Array, Date, etc.). */
  richStorableValues: boolean;
}

const defaultConfig: ExperimentalStorableConfig = {
  richStorableValues: false,
};

let currentConfig: ExperimentalStorableConfig = { ...defaultConfig };

/**
 * Activates experimental storable-value features. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions` into the memory layer.
 * Merges the provided partial config with defaults.
 */
export function setStorableValueConfig(
  config: Partial<ExperimentalStorableConfig>,
): void {
  currentConfig = { ...defaultConfig, ...config };
}

/** Returns the current experimental storable-value configuration. */
export function getExperimentalStorableConfig(): ExperimentalStorableConfig {
  return currentConfig;
}

/**
 * Restores experimental storable-value configuration to defaults. Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetStorableValueConfig(): void {
  currentConfig = { ...defaultConfig };
}

// ---------------------------------------------------------------------------
// Flag-dispatched deep conversion
// ---------------------------------------------------------------------------

/**
 * Convert a native JS value to storable form (deep, recursive).
 *
 * Flag OFF (legacy): performs deep conversion via `storableFromNativeValueLegacy`.
 * Flag ON (rich): wraps native types (Error, Date, RegExp, etc.) into
 * storable wrappers and deep-freezes via `storableFromNativeValueRich`.
 *
 * @param freeze - When `true` (default), deep-freezes the result. Only
 *   applies when `richStorableValues` is ON; the legacy path does not
 *   freeze.
 */
export function storableFromNativeValue(
  value: unknown,
  freeze = true,
): StorableValue {
  return currentConfig.richStorableValues
    ? storableFromNativeValueRich(value, freeze)
    : storableFromNativeValueLegacy(value);
}

/**
 * Convert a storable value back to native form.
 *
 * Flag OFF (legacy): identity passthrough. Flag ON (rich): unwraps storable
 * wrappers (StorableError, StorableMap, etc.) back to native JS types via
 * `nativeFromStorableValueRich`.
 *
 * @param frozen - When `true` (default), deep-freezes the result. Only
 *   applies when `richStorableValues` is ON; the legacy path is a
 *   passthrough regardless.
 */
export function nativeFromStorableValue(
  value: StorableValue,
  frozen = true,
): StorableValue {
  return currentConfig.richStorableValues
    ? nativeFromStorableValueRich(value, frozen) as StorableValue
    : value;
}

/**
 * Clone an already-valid `StorableValue` to achieve a desired frozenness,
 * with control over depth and copy semantics.
 *
 * Unlike `storableFromNativeValue` (which converts native JS values into
 * storable wrappers), this function assumes the input is already a valid
 * `StorableValue` and only adjusts frozenness by cloning where necessary.
 *
 * Flag OFF (legacy): identity passthrough (legacy values are not frozen).
 * Flag ON (rich): delegates to `cloneIfNecessaryRich`.
 *
 * @param value - An already-valid `StorableValue`.
 * @param options - See `CloneOptions`. Defaults: `{ frozen: true, deep: true }`.
 */
export function cloneIfNecessary(
  value: StorableValue,
  options?: CloneOptions & { frozen?: true },
): Immutable<StorableValue>;
export function cloneIfNecessary(
  value: StorableValue,
  options: CloneOptions & { frozen: false },
): StorableValue;
export function cloneIfNecessary(
  value: StorableValue,
  options?: CloneOptions,
): StorableValue;
export function cloneIfNecessary(
  value: StorableValue,
  options?: CloneOptions,
): StorableValue {
  const frozen = options?.frozen ?? true;
  const deep = options?.deep ?? true;
  const force = options?.force ?? (frozen ? false : true);

  if (frozen && force) {
    throw new Error(
      "cloneIfNecessary: { frozen: true, force: true } is invalid " +
        "(pointless to force-copy an immutable value)",
    );
  }

  if (!frozen && !force && deep) {
    throw new Error(
      "cloneIfNecessary: { frozen: false, force: false, deep: true } is invalid " +
        "(ambiguous: mixed-frozenness trees have no clear shallow-thaw semantics)",
    );
  }

  if (!currentConfig.richStorableValues) return value;

  return cloneIfNecessaryRich(value, frozen, deep, force);
}

// ---------------------------------------------------------------------------
// Flag-dispatched type checks
// ---------------------------------------------------------------------------

/**
 * Determines if the given value is considered "storable" by the system per se
 * (without invoking any conversions such as `.toJSON()`). This function does
 * not recursively validate nested values in arrays or objects.
 *
 * Flag OFF (legacy): storable values are JSON-encodable values plus
 * `undefined`. Flag ON (rich): delegates to `isStorableValueRich` which
 * accepts the extended type system.
 *
 * @param value - The value to check.
 * @returns `true` if the value is storable per se, `false` otherwise.
 */
export function isStorableValue(
  value: unknown,
): value is StorableValueLayer {
  return currentConfig.richStorableValues
    ? isStorableValueRich(value)
    : isStorableValueLegacy(value);
}

/**
 * Returns `true` if `storableFromNativeValue()` would succeed on the value.
 * Checks whether the value is a `StorableValue`, a `StorableNativeObject`,
 * or a deep tree thereof.
 *
 * Flag OFF (legacy): equivalent to `isStorableValue()` (non-recursive).
 * Flag ON (rich): delegates to the rich `canBeStored` which recursively
 * validates nested values.
 *
 * @param value - The value to check.
 * @returns `true` if the value can be stored, `false` otherwise.
 */
export function canBeStored(
  value: unknown,
): value is StorableValue | StorableNativeObject {
  return currentConfig.richStorableValues
    ? canBeStoredRich(value)
    : canBeStoredLegacy(value);
}

// ---------------------------------------------------------------------------
// Flag-dispatched shallow conversion
// ---------------------------------------------------------------------------

/**
 * Converts a value to storable form without recursing into nested values.
 * JSON-encodable values pass through as-is. Functions and instances are
 * converted via `toJSON()` if available.
 *
 * Flag OFF (legacy): JSON-only type system. Flag ON (rich): delegates to
 * `shallowStorableFromNativeValueRich` which handles the extended type system.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array. Only applies when `richStorableValues` is ON.
 * @returns The storable value (original or converted).
 * @throws Error if the value can't be converted to storable form.
 */
export function shallowStorableFromNativeValue(
  value: unknown,
  freeze = true,
): StorableValueLayer {
  return currentConfig.richStorableValues
    ? shallowStorableFromNativeValueRich(value, freeze)
    : shallowStorableFromNativeValueLegacy(value);
}

// ---------------------------------------------------------------------------
// Flag-dispatched comparison
// ---------------------------------------------------------------------------

/**
 * Compares two storable values for equality.
 *
 * Flag OFF (legacy): uses JSON.stringify comparison, matching the behavior of
 * the original `JSON.parse(JSON.stringify(...))` round-trip (strips undefined,
 * coerces NaN to null, etc.).
 *
 * Flag ON (rich): uses deep structural equality that correctly handles
 * undefined, sparse arrays, and other extended types.
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  return currentConfig.richStorableValues
    ? deepEqual(a, b)
    : JSON.stringify(a) === JSON.stringify(b);
}
