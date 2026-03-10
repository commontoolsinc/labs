import type { StorableValue } from "./interface.ts";
import { toDeepRichStorableValue } from "./rich-storable-value.ts";
import { deepNativeValueFromStorableValue } from "./storable-native-instances.ts";
import { toDeepStorableValue } from "./storable-value.ts";

// ---------------------------------------------------------------------------
// Flag-dispatched public API
//
// These two symbols are reassigned by `configureDispatch()` whenever the
// storable value conversion flag changes. When OFF (default),
// `storableFromNativeValue` routes through `toDeepStorableValue` (legacy
// conversion) and `nativeFromStorableValue` is an identity passthrough. When ON, they
// route through the rich storable value conversion functions.
// ---------------------------------------------------------------------------

/**
 * Convert a native JS value to storable form (deep, recursive).
 *
 * When the flag is ON, wraps native types (Error, Date, RegExp, etc.) into
 * storable wrappers and deep-freezes. When OFF, performs legacy deep
 * conversion via `toDeepStorableValue`.
 *
 * @param freeze - When `true` (default), deep-freezes the result. Only
 *   applies when `richStorableValues` is ON; the legacy path does not
 *   freeze.
 */
export let storableFromNativeValue: (
  value: StorableValue,
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
// Storable value conversion flag and dispatch configuration
// ---------------------------------------------------------------------------

/**
 * Module-level flag for storable value conversion, set by the `Runtime`
 * constructor via `setStorableValueConfig()`. When enabled, the public
 * API symbols dispatch through the rich conversion functions.
 */
let storableValueEnabled = false;

/**
 * Reassign the public API symbols based on the current value of
 * `storableValueEnabled`. Called at module load and whenever the flag
 * changes.
 */
function configureDispatch(): void {
  if (storableValueEnabled) {
    // ----- Rich storable value implementations -----

    storableFromNativeValue = (
      value: StorableValue,
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

    storableFromNativeValue = (value: StorableValue): StorableValue => {
      return toDeepStorableValue(value);
    };

    nativeFromStorableValue = (value: StorableValue): StorableValue => {
      return value;
    };
  }
}

/**
 * Activates or deactivates storable value conversion mode. Called by the
 * `Runtime` constructor to propagate
 * `ExperimentalOptions.richStorableValues` into the memory layer.
 */
export function setStorableValueConfig(enabled: boolean): void {
  storableValueEnabled = enabled;
  configureDispatch();
}

/**
 * Restores storable value conversion mode to its default (disabled).
 * Called by `Runtime.dispose()` to avoid leaking flags between runtime
 * instances or test runs.
 */
export function resetStorableValueConfig(): void {
  storableValueEnabled = false;
  configureDispatch();
}

// ---------------------------------------------------------------------------
// Initialize dispatch to legacy conversion mode at module load.
// ---------------------------------------------------------------------------

configureDispatch();
