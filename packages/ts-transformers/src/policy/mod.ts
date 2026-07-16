export { analyzeFunctionCapabilities } from "./capability-analysis.ts";
export {
  createDeriveSchedulerOptions,
  hasCompleteSchedulerScopeSummary,
} from "./derive-scheduler-options.ts";
export {
  type MergeablePushMisuse,
  type MergeablePushMisuseKind,
} from "./mergeable-push-classification.ts";
export {
  classifyReactiveReceiverKind,
  type ReactiveReceiverKind,
  shouldLowerLogicalExpression,
  shouldRewriteCollectionMethod,
} from "./rewrite-policy.ts";
