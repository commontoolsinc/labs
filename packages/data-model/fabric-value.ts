import {
  type FabricInstance,
  isFabricInstance,
  RECONSTRUCT,
} from "./fabric-instance.ts";
export { isFabricInstance };
import type { FabricPrimitive } from "./fabric-primitive.ts";
import { deepEqual } from "@commontools/utils/deep-equal";
import type { Immutable } from "@commontools/utils/types";
import {
  canBeStoredRich,
  cloneIfNecessaryRich,
  type CloneOptions,
  fabricFromNativeValueModern,
  isFabricValueModern,
  shallowFabricFromNativeValueModern,
} from "./fabric-value-modern.ts";
export type { CloneOptions } from "./fabric-value-modern.ts";
import { nativeFromFabricValueModern } from "./fabric-native-instances.ts";
import {
  canBeStoredLegacy,
  cloneIfNecessaryLegacy,
  fabricFromNativeValueLegacy,
  isFabricValueLegacy,
  shallowFabricFromNativeValueLegacy,
} from "./fabric-value-legacy.ts";
export {
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
} from "./array-utils.ts";

// ===========================================================================
// Type definitions
// ===========================================================================

/**
 * A value that can be stored in the storage layer. This is similar to
 * `JSONValue` but is specifically intended for use at storage boundaries
 * (values going into or coming out of the database).
 *
 * Note: Once the `modernDataModel` experiment graduates and the rich path
 * becomes the default, `FabricValue = FabricDatum | undefined` will be a
 * redundant union (since `FabricDatum` includes `undefined`). The alias is
 * retained for compatibility and readability at call sites.
 */
export type FabricValue = FabricDatum | undefined;

/**
 * The full set of values that the storage layer can represent. This is the
 * strongly-typed "middle layer" of the three-layer architecture:
 *
 *   JavaScript "wild west" (unknown) <-> FabricValue <-> Serialized (Uint8Array)
 *
 * Most native JS object types (`Error`, `Map`, `Set`, `Uint8Array`) enter the
 * fabric layer via wrapper classes that implement `FabricInstance`. However,
 * fabric primitives (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`) and
 * `bigint` are direct members of `FabricDatum` without implementing
 * `FabricInstance`. Native `Date` is converted to `FabricEpochNsec` during
 * conversion.
 *
 * `undefined` is preserved when the `modernDataModel` flag is ON. When the
 * flag is OFF, `undefined` in arrays is converted to `null` and `undefined`
 * object properties are omitted -- matching legacy behavior.
 */
export type FabricDatum =
  // -- Primitives --
  | null
  | boolean
  | number
  | string
  | bigint
  // -- Fabric primitives (FabricEpochNsec, FabricEpochDays, FabricHash) --
  | FabricPrimitive
  // -- Containers --
  | FabricArray
  | FabricObject
  // -- Protocol types (Cell, Stream, UnknownValue, ProblematicValue,
  //    and native wrappers like FabricError at runtime) --
  | FabricInstance
  // -- Extended primitives (experimental: modernDataModel) --
  | undefined;

/** An array of fabric data. */
export interface FabricArray extends ArrayLike<FabricDatum> {}

/**
 * An object/record of fabric data.
 *
 * Note: `__proto__` and `constructor` properties are not currently guarded
 * against at the type level or at runtime in clone/conversion internals.
 * If prototype pollution becomes a concern, add boundary validation where
 * values enter the fabric system (e.g., `fabricFromNativeValue`).
 */
export interface FabricObject extends Record<string, FabricDatum> {}

/**
 * A single "layer" of fabric conversion -- the result of shallow conversion
 * via `shallowFabricFromNativeValue()`. Arrays and objects have the right
 * shape but their contents may still contain values requiring further
 * conversion (e.g., Error instances in a `cause` chain).
 */
export type FabricValueLayer =
  | FabricValue
  | unknown[]
  | Record<string, unknown>;

/**
 * Union of raw native JS **object** types that the fabric type system can
 * convert into `FabricInstance` wrappers. These are the inputs to the
 * "sausage grinder" -- `shallowFabricFromNativeValue()` accepts
 * `FabricValue | FabricNativeObject`, meaning callers can pass in either
 * already-fabric data or raw native JS objects. The conversion produces
 * `FabricInstance` wrappers (FabricError, FabricMap, etc.) that live
 * inside `FabricValue` via the `FabricInstance` arm of `FabricDatum`.
 *
 * `Blob` is included because `FabricUint8Array.toNativeValue(true)` returns
 * a `Blob` (immutable by nature) instead of a `Uint8Array`. The synchronous
 * serialization path throws on `Blob` since its data access methods are async.
 *
 * The `{ toJSON(): unknown }` arm covers objects (and functions) that are
 * convertible to fabric form via their `toJSON()` method. This is a legacy
 * conversion path but is included here so the `canBeStored()` type predicate
 * (`value is FabricValue | FabricNativeObject`) remains sound.
 *
 * Note: `bigint` is NOT included here -- it is a primitive (like `undefined`)
 * and belongs directly in `FabricDatum` without wrapping.
 */
export type FabricNativeObject =
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | RegExp
  | Uint8Array
  | Blob
  | { toJSON(): unknown };

// ===========================================================================
// Fabric protocol interfaces
// ===========================================================================

/**
 * A class that can reconstruct fabric instances from essential state. The
 * static `[RECONSTRUCT]` method is separate from the constructor to support
 * reconstruction-specific context and instance interning.
 * See Section 2.4 of the formal spec.
 */
export interface FabricClass<T extends FabricInstance> {
  /**
   * Reconstruct an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * A converter that can reconstruct arbitrary values (not necessarily
 * `FabricInstance`s) from essential state. Used for built-in JS types like
 * `Error` that participate in the serialization protocol but don't implement
 * `FabricInstance`. See Section 1.4.1 of the formal spec.
 */
export interface FabricValueConverter<T> {
  /**
   * Reconstruct a value from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * The minimal interface that `[RECONSTRUCT]` implementations may depend on.
 * Provided by the `Runtime` in practice, but defined as an interface here to
 * avoid a circular dependency between the fabric protocol and the runner.
 * See Section 2.5 of the formal spec.
 */
export interface ReconstructionContext {
  /** Resolve a cell reference. Used by types that need to intern or look up
   *  existing instances during reconstruction. */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;
}

/**
 * Public boundary interface for serialization contexts. Encodes fabric
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /** Whether failed reconstructions produce `ProblematicValue` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Encode a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;

  /** Decode a serialized form back into a fabric value. */
  decode(
    data: SerializedForm,
    runtime: ReconstructionContext,
  ): FabricValue;
}

// ===========================================================================
// Experimental data model configuration
// ===========================================================================

/**
 * Configuration for experimental data model features gated behind
 * `RuntimeOptions.experimental`. Uses ambient (module-level) state so that
 * deep call sites can check flags without parameter threading.
 *
 * See Section 1 of the formal spec (`docs/specs/space-model-formal-spec/`).
 */
export interface ExperimentalDataModelConfig {
  /** When `true`, fabric value functions use the extended type system
   *  (bigint, Map, Set, Uint8Array, Date, etc.). */
  modernDataModel: boolean;
}

const defaultConfig: ExperimentalDataModelConfig = {
  modernDataModel: false,
};

let currentConfig: ExperimentalDataModelConfig = { ...defaultConfig };

/**
 * Activates experimental data model features. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions` into the memory layer.
 * Merges the provided partial config with defaults.
 */
export function setDataModelConfig(
  config: Partial<ExperimentalDataModelConfig>,
): void {
  currentConfig = { ...defaultConfig, ...config };
}

/** Returns the current experimental data model configuration. */
export function getDataModelConfig(): ExperimentalDataModelConfig {
  return currentConfig;
}

/**
 * Restores experimental data model configuration to defaults. Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetDataModelConfig(): void {
  currentConfig = { ...defaultConfig };
}

// ---------------------------------------------------------------------------
// Flag-dispatched deep conversion
// ---------------------------------------------------------------------------

/**
 * Convert a native JS value to fabric form (deep, recursive).
 *
 * Flag OFF (legacy): performs deep conversion via `fabricFromNativeValueLegacy`.
 * Flag ON (rich): wraps native types (Error, Date, RegExp, etc.) into
 * fabric wrappers and deep-freezes via `fabricFromNativeValueModern`.
 *
 * @param freeze - When `true` (default), deep-freezes the result. Only
 *   applies when `modernDataModel` is ON; the legacy path does not
 *   freeze.
 */
export function fabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValue {
  return currentConfig.modernDataModel
    ? fabricFromNativeValueModern(value, freeze)
    : fabricFromNativeValueLegacy(value);
}

/**
 * Convert a fabric value back to native form.
 *
 * Flag OFF (legacy): identity passthrough. Flag ON (rich): unwraps fabric
 * wrappers (FabricError, FabricMap, etc.) back to native JS types via
 * `nativeFromFabricValueModern`.
 *
 * @param frozen - When `true` (default), deep-freezes the result. Only
 *   applies when `modernDataModel` is ON; the legacy path is a
 *   passthrough regardless.
 */
export function nativeFromFabricValue(
  value: FabricValue,
  frozen = true,
): FabricValue {
  return currentConfig.modernDataModel
    ? nativeFromFabricValueModern(value, frozen) as FabricValue
    : value;
}

/**
 * Clone an already-valid `FabricValue` to achieve a desired frozenness,
 * with control over depth and copy semantics.
 *
 * Unlike `fabricFromNativeValue` (which converts native JS values into
 * fabric wrappers), this function assumes the input is already a valid
 * `FabricValue` and only adjusts frozenness by cloning where necessary.
 *
 * Flag OFF (legacy): identity passthrough (legacy values are not frozen).
 * Flag ON (rich): delegates to `cloneIfNecessaryRich`.
 *
 * @param value - An already-valid `FabricValue`.
 * @param options - See `CloneOptions`. Defaults: `{ frozen: true, deep: true }`.
 */
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions & { frozen?: true },
): Immutable<T>;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options: CloneOptions & { frozen: false },
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T {
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

  return (currentConfig.modernDataModel
    ? cloneIfNecessaryRich(value, frozen, deep, force)
    : cloneIfNecessaryLegacy(value, frozen, deep, force)) as T;
}

// ---------------------------------------------------------------------------
// Flag-dispatched type checks
// ---------------------------------------------------------------------------

/**
 * Determines if the given value is considered "fabric-compatible" by the system per se
 * (without invoking any conversions such as `.toJSON()`). This function does
 * not recursively validate nested values in arrays or objects.
 *
 * Flag OFF (legacy): fabric values are JSON-encodable values plus
 * `undefined`. Flag ON (rich): delegates to `isFabricValueModern` which
 * accepts the extended type system.
 *
 * @param value - The value to check.
 * @returns `true` if the value is fabric-compatible per se, `false` otherwise.
 */
export function isFabricValue(
  value: unknown,
): value is FabricValueLayer {
  return currentConfig.modernDataModel
    ? isFabricValueModern(value)
    : isFabricValueLegacy(value);
}

/**
 * Returns `true` if `fabricFromNativeValue()` would succeed on the value.
 * Checks whether the value is a `FabricValue`, a `FabricNativeObject`,
 * or a deep tree thereof.
 *
 * Flag OFF (legacy): equivalent to `isFabricValue()` (non-recursive).
 * Flag ON (rich): delegates to the rich `canBeStored` which recursively
 * validates nested values.
 *
 * @param value - The value to check.
 * @returns `true` if the value can be stored, `false` otherwise.
 */
export function canBeStored(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return currentConfig.modernDataModel
    ? canBeStoredRich(value)
    : canBeStoredLegacy(value);
}

// ---------------------------------------------------------------------------
// Flag-dispatched shallow conversion
// ---------------------------------------------------------------------------

/**
 * Converts a value to fabric form without recursing into nested values.
 * JSON-encodable values pass through as-is. Functions and instances are
 * converted via `toJSON()` if available.
 *
 * Flag OFF (legacy): JSON-only type system. Flag ON (rich): delegates to
 * `shallowFabricFromNativeValueModern` which handles the extended type system.
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
  return currentConfig.modernDataModel
    ? shallowFabricFromNativeValueModern(value, freeze)
    : shallowFabricFromNativeValueLegacy(value);
}

// ---------------------------------------------------------------------------
// Flag-dispatched comparison
// ---------------------------------------------------------------------------

/**
 * Compares two fabric values for equality.
 *
 * Flag OFF (legacy): uses JSON.stringify comparison, matching the behavior of
 * the original `JSON.parse(JSON.stringify(...))` round-trip (strips undefined,
 * coerces NaN to null, etc.).
 *
 * Flag ON (rich): uses deep structural equality that correctly handles
 * undefined, sparse arrays, and other extended types.
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  return currentConfig.modernDataModel
    ? deepEqual(a, b)
    : JSON.stringify(a) === JSON.stringify(b);
}
