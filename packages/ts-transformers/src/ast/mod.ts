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
  isFunctionParameter,
  isMethodCall,
  isOptionalPropertyAccess,
  setParentPointers,
  visitEachChildWithJsx,
} from "./utils.ts";
export {
  getTypeReferenceArgument,
  inferParameterType,
  inferReturnType,
  isAnyOrUnknownType,
  typeToSchemaTypeNode,
  typeToTypeNode,
  unwrapOpaqueLikeType,
} from "./type-inference.ts";
