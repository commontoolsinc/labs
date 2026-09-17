export { fabricAwareEqual, valueEqual } from "@/comparison";

export {
  deepFreeze,
  isDeepFrozen,
  isValidDeepFrozenFabricValue,
} from "./deep-freeze.ts";

export * from "./interface.ts";

export {
  convertibleJsFromFabricValue,
  fabricFromConvertibleJsValue,
  isValidFabricConvertibleJsValue,
  shallowCleanArray,
  shallowCleanPlainObject,
  shallowFabricFromConvertibleJsObjectElseUndefined,
  shallowFabricFromConvertibleJsValue,
} from "./convertible-js.ts";

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
  toShortQuotedDebugString,
  toStructuredDebugValue,
} from "./value-debug.ts";

export {
  getFrozenObjectHashCacheHits,
  hashOf,
  hashStringOf,
  taggedHashStringOf,
} from "./value-hash.ts";

export * from "@/types";
