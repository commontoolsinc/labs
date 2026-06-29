export { analyzeFunctionCapabilities } from "./capability-analysis.ts";
export {
  classifyReactiveReceiverKind,
  type ReactiveReceiverKind,
  shouldLowerLogicalExpression,
  shouldRewriteCollectionMethod,
  SUPPORTED_EXPR_BINARY_OPERATORS,
  SUPPORTED_EXPR_UNARY_OPERATORS,
} from "./rewrite-policy.ts";
