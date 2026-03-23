export {
  type CallKind,
  detectCallKind,
  detectDirectBuilderCall,
  isReactiveOriginCall,
  isReactiveValueExpression,
  isReactiveValueSymbol,
  isSimpleReactiveAccessExpression,
} from "./call-kind.ts";
export * from "./dataflow.ts";
export {
  classifyReactiveContext,
  findEnclosingCallbackContext,
  isInRestrictedReactiveContext,
  isInsideRestrictedContext,
  isInsideSafeCallbackWrapper,
  isInsideSafeWrapper,
  isStandaloneFunctionDefinition,
  type ReactiveContextInfo,
  type ReactiveContextKind,
  type ReactiveContextLookup,
  type ReactiveContextOwner,
  RESTRICTED_CONTEXT_BUILDERS,
  SAFE_WRAPPER_BUILDERS,
} from "./reactive-context.ts";
export * from "./normalize.ts";
export {
  isEventHandlerJsxAttribute,
  isEventHandlerType,
  isSafeEventHandlerCall,
} from "./event-handlers.ts";
export { isFunctionLikeExpression } from "./function-predicates.ts";
export {
  getExpressionText,
  getMemberSymbol,
  getMethodCallTarget,
  getTypeAtLocationWithFallback,
  getVariableInitializer,
  isFunctionParameter,
  isMethodCall,
  isOptionalMemberSymbol,
  setParentPointers,
  visitEachChildWithJsx,
} from "./utils.ts";
export {
  getTypeFromTypeNodeWithFallback,
  getTypeReferenceArgument,
  hasArrayTypeArgument,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  inferWidenedTypeFromExpression,
  isAnyOrUnknownType,
  isDeriveCall,
  isReactiveArrayMethodCall,
  registerSyntheticCallType,
  typeToSchemaTypeNode,
  typeToTypeNode,
  unwrapOpaqueLikeType,
  widenLiteralType,
} from "./type-inference.ts";
