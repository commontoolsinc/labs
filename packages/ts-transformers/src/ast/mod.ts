export { type CallKind, detectCallKind } from "./call-kind.ts";
export * from "./dataflow.ts";
export * from "./normalize.ts";
export {
  isEventHandlerJsxAttribute,
  isSafeEventHandlerCall,
} from "./event-handlers.ts";
export {
  getExpressionText,
  getMemberSymbol,
  getMethodCallTarget,
  isFunctionParameter,
  isMethodCall,
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
