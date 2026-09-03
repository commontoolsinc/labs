/**
 * This module is the package's main entry point, and the canonical public
 * surface for the `FabricValue` types: the type declarations, the
 * `FabricInstance` base class, and the functions that operate on them. Those
 * are spread across several modules, not all of which the package exports on
 * their own, and a caller should not have to know which is which. Alongside
 * them are the operations every `FabricValue` is subject to whatever its
 * class: the deep freeze, the hash, the debug rendering, and the tag vocabulary
 * that names a value's type. The rest of the package -- the codec system and
 * the concrete value classes -- is reached through the exported subpaths named
 * in `deno.jsonc`, not through here.
 */

// Re-export everything from `interface.ts`, which declares the types and the
// base class.
export {
  type FabricArray,
  type FabricContainerValue,
  type FabricConvertibleValue,
  FabricInstance,
  type FabricNativeObject,
  type FabricPlainObject,
  FabricPrimitive,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
  type MutableFabricArrayLayer,
  type MutableFabricContainerValueLayer,
  type MutableFabricPlainObjectLayer,
  type MutableFabricValueLayer,
  type NonNullableFabricValue,
} from "./interface.ts";

export type { CompactDebugStringOptions, DebugValueOptions } from "./api.ts";

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

export {
  assertValidFabricValueLayer,
  isFabricContainerValue,
  isFabricObjectOrArray,
  isFabricPlainContainer,
  isFabricPlainObject,
  isValidFabricNativeObject,
  isValidFabricPlainObject,
  isValidFabricValue,
  isValidFabricValueLayer,
} from "./type-check.ts";

export {
  fabricFromNativeValue,
  isValidFabricConvertibleValue,
  nativeFromFabricValue,
  shallowCleanArray,
  shallowCleanPlainObject,
  shallowFabricFromNativeObjectElseUndefined,
  shallowFabricFromNativeValue,
} from "./native-conversion.ts";

export { valueEqual } from "./valueEqual.ts";

export {
  deepFreeze,
  isDeepFrozen,
  isValidDeepFrozenFabricValue,
} from "./deep-freeze.ts";

export { tagFromNativeClass, tagFromNativeValue } from "./native-type-tags.ts";

export {
  toCompactDebugString,
  toDebugKindString,
  toIndentedDebugString,
  toStructuredDebugValue,
} from "./value-debug.ts";

export { hashOf, hashStringOf, taggedHashStringOf } from "./value-hash.ts";

export { VALUE_TAGS, type ValueTag } from "./VALUE_TAGS.ts";
