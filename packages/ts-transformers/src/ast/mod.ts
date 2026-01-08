export { type CallKind, detectCallKind } from "./call-kind.ts";
export * from "./dataflow.ts";
export {
  findEnclosingCallbackContext,
  isInRestrictedReactiveContext,
  isInsideRestrictedContext,
  isInsideSafeWrapper,
  RESTRICTED_CONTEXT_BUILDERS,
  SAFE_WRAPPER_BUILDERS,
} from "./reactive-context.ts";
export * from "./normalize.ts";
export {
  isEventHandlerJsxAttribute,
  isSafeEventHandlerCall,
} from "./event-handlers.ts";
export { isFunctionLikeExpression } from "./function-predicates.ts";
export {
  getExpressionText,
  getMemberSymbol,
  getMethodCallTarget,
  getTypeAtLocationWithFallback,
  isFunctionParameter,
  isMethodCall,
  isOptionalProperty,
  isOptionalPropertyAccess,
  setParentPointers,
  visitEachChildWithJsx,
} from "./utils.ts";
export {
  getTypeFromTypeNodeWithFallback,
  getTypeReferenceArgument,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  inferWidenedTypeFromExpression,
  isAnyOrUnknownType,
  registerSyntheticCallType,
  typeToSchemaTypeNode,
  typeToTypeNode,
  unwrapOpaqueLikeType,
  widenLiteralType,
} from "./type-inference.ts";
