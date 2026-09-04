// Re-export everything from `interface.ts`, which declares the types and the
// base class.
export {
  type CompactDebugStringOptions,
  type DebugValueOptions,
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
  type FromNativeErrorOptions,
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
  assertValidFabricValueLayer,
  isFabricContainerValue,
  isFabricObjectOrArray,
  isFabricPlainContainer,
  isFabricPlainObject,
  isValidFabricNativeObject,
  isValidFabricPlainObject,
  isValidFabricValue,
  isValidFabricValueLayer,
  isWalkableObjectNotArray,
  isWalkableObjectOrArray,
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

export { refuseFabricInstance } from "./refuse-fabric-instance.ts";

export { fabricAwareEqual, valueEqual } from "./valueEqual.ts";

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
