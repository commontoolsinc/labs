// Re-export everything from `interface.ts` so that `fabric-value` remains the
// canonical public surface for all type declarations and the `FabricInstance`
// base class.
export {
  DECONSTRUCT,
  type FabricArray,
  type FabricClass,
  FabricInstance,
  type FabricNativeObject,
  type FabricObject,
  FabricPrimitive,
  type FabricValue,
  type FabricValueConverter,
  type FabricValueLayer,
  RECONSTRUCT,
  type ReconstructionContext,
  type SerializationContext,
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

export { isFabricValue } from "./fabric-value-modern.ts";

export {
  fabricFromNativeValue,
  isFabricCompatible,
  nativeFromFabricValue,
  shallowFabricFromNativeValue,
} from "./native-conversion.ts";

import { deepEqual } from "@commonfabric/utils/deep-equal";

/**
 * Compares two fabric values for equality.
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  // TODO(danfuzz): This needs to be a `data-model`-aware function.
  // `deepEqual()` is not that.
  return deepEqual(a, b);
}
