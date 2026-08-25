/**
 * This module is the canonical public surface for the `FabricValue` types: the
 * type declarations, the `FabricInstance` base class, and the functions that
 * operate on them. Those are spread across several modules, not all of which
 * the package exports on their own, and a caller should not have to know which
 * is which.
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
  isFabricContainerValue,
  isFabricObjectOrArray,
  isFabricPlainContainer,
  isFabricPlainObject,
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
  shallowFabricFromNativeValue,
} from "./native-conversion.ts";

export { valueEqual } from "./valueEqual.ts";
