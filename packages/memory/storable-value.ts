import { deepEqual } from "@commontools/utils/deep-equal";
import type {
  StorableNativeObject,
  StorableValue,
  StorableValueLayer,
} from "./interface.ts";
import {
  canBeStored as canBeStoredRich,
  isRichStorableValue,
  toDeepRichStorableValue,
  toRichStorableValue,
} from "./storable-value-modern.ts";
import { deepNativeValueFromStorableValue } from "./storable-native-instances.ts";
import {
  canBeStoredLegacy,
  isStorableValueLegacy,
  shallowStorableFromNativeValueLegacy,
  toDeepStorableValueLegacy,
} from "./storable-value-legacy.ts";

// ---------------------------------------------------------------------------
// Flag-dispatched public API
//
// These two symbols are reassigned by `configureDispatch()` whenever the
// storable value conversion flag changes. When OFF (default),
// `storableFromNativeValue` routes through `toDeepStorableValueLegacy` (legacy
// conversion) and `nativeFromStorableValue` is an identity passthrough. When ON, they
// route through the rich storable value conversion functions.
// ---------------------------------------------------------------------------

/**
 * Convert a native JS value to storable form (deep, recursive).
 *
 * When the flag is ON, wraps native types (Error, Date, RegExp, etc.) into
 * storable wrappers and deep-freezes. When OFF, performs legacy deep
 * conversion via `toDeepStorableValueLegacy`.
 *
 * @param freeze - When `true` (default), deep-freezes the result. Only
 *   applies when `richStorableValues` is ON; the legacy path does not
 *   freeze.
 */
export let storableFromNativeValue: (
  value: unknown,
  freeze?: boolean,
) => StorableValue;

/**
 * Convert a storable value back to native form. When the flag is ON,
 * unwraps storable wrappers (StorableError, StorableMap, etc.) back to
 * native JS types. When OFF, identity passthrough.
 *
 * @param frozen - When `true` (default), deep-freezes the result. Only
 *   applies when `richStorableValues` is ON; the legacy path is a
 *   passthrough regardless.
 */
export let nativeFromStorableValue: (
  value: StorableValue,
  frozen?: boolean,
) => StorableValue;

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
export function setExperimentalStorableConfig(
  config: Partial<ExperimentalStorableConfig>,
): void {
  currentConfig = { ...defaultConfig, ...config };
  configureDispatch();
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
export function resetExperimentalStorableConfig(): void {
  currentConfig = { ...defaultConfig };
  configureDispatch();
}

// ---------------------------------------------------------------------------
// Dispatch configuration
// ---------------------------------------------------------------------------

/**
 * Reassign the public API symbols based on the current value of
 * `currentConfig.richStorableValues`. Called at module load and whenever
 * the config changes.
 */
function configureDispatch(): void {
  if (currentConfig.richStorableValues) {
    // ----- Rich storable value implementations -----

    storableFromNativeValue = (
      value: unknown,
      freeze = true,
    ): StorableValue => {
      return toDeepRichStorableValue(value, freeze);
    };

    nativeFromStorableValue = (
      value: StorableValue,
      frozen = true,
    ): StorableValue => {
      return deepNativeValueFromStorableValue(value, frozen) as StorableValue;
    };
  } else {
    // ----- Legacy conversion (flag OFF) -----

    storableFromNativeValue = (value: unknown): StorableValue => {
      return toDeepStorableValueLegacy(value);
    };

    nativeFromStorableValue = (value: StorableValue): StorableValue => {
      return value;
    };
  }
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
 * `undefined`. Flag ON (rich): delegates to `isRichStorableValue` which
 * accepts the extended type system.
 *
 * @param value - The value to check.
 * @returns `true` if the value is storable per se, `false` otherwise.
 */
export function isStorableValue(
  value: unknown,
): value is StorableValueLayer {
  if (currentConfig.richStorableValues) {
    return isRichStorableValue(value);
  }
  return isStorableValueLegacy(value);
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
  if (currentConfig.richStorableValues) {
    return canBeStoredRich(value);
  }
  return canBeStoredLegacy(value);
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
 * `toRichStorableValue` which handles the extended type system.
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
  if (currentConfig.richStorableValues) {
    return toRichStorableValue(value, freeze);
  }
  return shallowStorableFromNativeValueLegacy(value);
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
  if (currentConfig.richStorableValues) {
    return deepEqual(a, b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Initialize dispatch to legacy conversion mode at module load.
// ---------------------------------------------------------------------------

configureDispatch();
