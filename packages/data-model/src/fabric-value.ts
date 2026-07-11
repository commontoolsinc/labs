// Re-export everything from `interface.ts` so that `fabric-value` remains the
// canonical public surface for all type declarations and the `FabricInstance`
// base class.
export {
  type FabricArray,
  type FabricFactory,
  FabricInstance,
  type FabricNativeObject,
  type FabricPlainObject,
  FabricPrimitive,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";

export {
  type FactoryArtifactRef,
  factoryStateOf,
  type FactoryStateV1,
  type FactoryStateView,
  type HandlerFactoryStateV1,
  type LiveFactoryState,
  type LiveHandlerFactoryState,
  type LiveModuleFactoryState,
  type LivePatternFactoryState,
  type ModuleFactoryStateV1,
  type PatternFactoryStateV1,
  registerFabricFactory,
  tryFactoryState,
} from "./fabric-factory.ts";

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

export { isFabricPlainObject, isFabricValueLayer } from "./type-check.ts";

export {
  fabricFromNativeValue,
  isFabricCompatible,
  nativeFromFabricValue,
  shallowFabricFromNativeValue,
} from "./native-conversion.ts";

export { valueEqual } from "./valueEqual.ts";
