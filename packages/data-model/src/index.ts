export { fabricAwareEqual, valueEqual } from "@/comparison";

export {
  deepFreeze,
  isDeepFrozen,
  isValidDeepFrozenFabricValue,
} from "./deep-freeze.ts";

export type * from "./interface.ts";

export { FabricInstance, FabricPrimitive } from "./interface.ts";

export {
  fabricFromNativeValue,
  isValidFabricConvertibleValue,
  nativeFromFabricValue,
  shallowCleanArray,
  shallowCleanPlainObject,
  shallowFabricFromNativeObjectElseUndefined,
  shallowFabricFromNativeValue,
} from "./native-conversion.ts";

export { refuseFabricInstance } from "./refuseFabricInstance.ts";

export {
  isFabricArray,
  isFabricContainerValue,
  isFabricObjectOrArray,
  isFabricPlainContainer,
  isFabricPlainObject,
  isFabricSpecialObject,
  isKeyableObjectNotArray,
  isKeyableObjectOrArray,
  isWalkableObjectNotArray,
  isWalkableObjectOrArray,
} from "./type-check.ts";

export {
  assertValidFabricValueLayer,
  isValidFabricNativeObject,
  isValidFabricPlainObject,
  isValidFabricValue,
  isValidFabricValueLayer,
} from "./validity-check.ts";

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
  toCompactDebugString,
  toDebugKindString,
  toIndentedDebugString,
  toStructuredDebugValue,
} from "./value-debug.ts";

export { hashOf, hashStringOf, taggedHashStringOf } from "./value-hash.ts";

export * from "@/value-tags";
