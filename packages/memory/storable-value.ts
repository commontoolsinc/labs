import type { StorableValue } from "./interface.ts";
import { toDeepRichStorableValue } from "./storable-value-modern.ts";
import { deepNativeValueFromStorableValue } from "./storable-native-instances.ts";
import { toDeepStorableValue } from "./storable-value-legacy.ts";

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
      return toDeepStorableValue(value);
    };

    nativeFromStorableValue = (value: StorableValue): StorableValue => {
      return value;
    };
  }
}

// ---------------------------------------------------------------------------
// Initialize dispatch to legacy conversion mode at module load.
// ---------------------------------------------------------------------------

configureDispatch();
