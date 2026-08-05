// Re-export everything from `interface.ts` so that `fabric-value` remains the
// canonical public surface for all type declarations and the `FabricInstance`
// base class.
export {
  type FabricArray,
  FabricInstance,
  type FabricNativeObject,
  type FabricOrConvertibleNativeValue,
  type FabricPlainObject,
  FabricPrimitive,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
  type MutableFabricArrayLayer,
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
  isFabricExecPlainObject,
  isFabricObjectOrArray,
  isFabricPlainObject,
  isFabricValue,
  isFabricValueLayer,
} from "./type-check.ts";

export {
  fabricFromNativeValue,
  isFabricCompatible,
  nativeFromFabricValue,
  shallowCleanArray,
  shallowCleanPlainObject,
  shallowFabricFromNativeValue,
} from "./native-conversion.ts";

export { valueEqual } from "./valueEqual.ts";
