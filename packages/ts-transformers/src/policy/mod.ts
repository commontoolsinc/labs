export {
  analyzeFunctionCapabilities,
  type MergeablePushMisuse,
} from "./capability-analysis.ts";
export {
  classifyReactiveReceiverKind,
  type ReactiveReceiverKind,
  shouldLowerLogicalExpression,
  shouldRewriteCollectionMethod,
} from "./rewrite-policy.ts";
