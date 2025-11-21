export { type CallKind, detectCallKind } from "./call-kind.ts";
export * from "./dataflow.ts";
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
  getTypeReferenceArgument,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  isAnyOrUnknownType,
  typeToSchemaTypeNode,
  typeToTypeNode,
  unwrapOpaqueLikeType,
} from "./type-inference.ts";
