import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "./cfc-invocation-context.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessToolEffectClass } from "./tool-descriptor.ts";
import type { HarnessToolInputSummary } from "./policy.ts";
import type { HarnessToolPolicyDecision } from "./run-report.ts";

export type HarnessPolicyDecisionReasonCode =
  | "tool_not_allowed"
  | "cfc_disabled"
  | "cfc_observe_read"
  | "cfc_observe_direct_command"
  | "cfc_observe_requires_direct_command"
  | "cfc_enforce_explicit_read"
  | "cfc_enforce_explicit_direct_command"
  | "cfc_enforce_explicit_requires_direct_command"
  | "cfc_enforce_strict_direct_command"
  | "cfc_enforce_strict_requires_direct_command"
  | "write_file_disabled"
  | "write_file_observe_direct_command"
  | "write_file_observe_requires_direct_command"
  | "write_file_enforce_explicit_direct_command"
  | "write_file_enforce_explicit_requires_direct_command"
  | "write_file_enforce_strict_direct_command"
  | "write_file_enforce_strict_requires_direct_command"
  | "subagent_profile_allowed"
  | "subagent_profile_not_allowed";

export interface HarnessPolicyDecisionRecord {
  type: "cf-harness.policy-decision";
  sequence: number;
  runId: string;
  at: string;
  toolActivitySequence: number;
  toolCallId: string;
  toolId: string;
  effectClass?: HarnessToolEffectClass;
  cfcEnforcementMode: CfcEnforcementMode;
  decision: HarnessToolPolicyDecision;
  reasonCodes: readonly HarnessPolicyDecisionReasonCode[];
  detail?: string;
  promptSlot?: PromptSlotBinding;
  toolInputSummary?: HarnessToolInputSummary;
  policyEventIndexes?: readonly number[];
  subagentProfile?: string;
}

export interface HarnessPolicyDecisionCounts {
  total: number;
  allowed: number;
  warned: number;
  denied: number;
}

export interface HarnessPolicyTrace {
  type: "cf-harness.policy-trace";
  version: 1;
  generatedAt: string;
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcPolicySnapshotPath?: string;
  cfcPolicySnapshotDigest?: string;
  decisionCounts: HarnessPolicyDecisionCounts;
  decisions: readonly HarnessPolicyDecisionRecord[];
  cfcInvocationContexts?: readonly HarnessCfcInvocationContext[];
}

export interface CreateHarnessPolicyDecisionRecordOptions
  extends Omit<HarnessPolicyDecisionRecord, "type" | "sequence" | "runId"> {
  sequence: number;
  runId: string;
}

export interface CreateHarnessPolicyTraceOptions {
  generatedAt: string;
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcPolicySnapshotPath?: string;
  cfcPolicySnapshotDigest?: string;
  decisions?: readonly HarnessPolicyDecisionRecord[];
  cfcInvocationContexts?: readonly HarnessCfcInvocationContext[];
}

export const createHarnessPolicyDecisionRecord = (
  options: CreateHarnessPolicyDecisionRecordOptions,
): HarnessPolicyDecisionRecord => ({
  type: "cf-harness.policy-decision",
  sequence: options.sequence,
  runId: options.runId,
  at: options.at,
  toolActivitySequence: options.toolActivitySequence,
  toolCallId: options.toolCallId,
  toolId: options.toolId,
  ...(options.effectClass !== undefined
    ? { effectClass: options.effectClass }
    : {}),
  cfcEnforcementMode: options.cfcEnforcementMode,
  decision: options.decision,
  reasonCodes: [...options.reasonCodes],
  ...(options.detail !== undefined ? { detail: options.detail } : {}),
  ...(options.promptSlot !== undefined
    ? { promptSlot: options.promptSlot }
    : {}),
  ...(options.toolInputSummary !== undefined
    ? { toolInputSummary: options.toolInputSummary }
    : {}),
  ...(options.policyEventIndexes !== undefined &&
      options.policyEventIndexes.length > 0
    ? { policyEventIndexes: [...options.policyEventIndexes] }
    : {}),
  ...(options.subagentProfile !== undefined
    ? { subagentProfile: options.subagentProfile }
    : {}),
});

export const countHarnessPolicyDecisions = (
  decisions: readonly HarnessPolicyDecisionRecord[] = [],
): HarnessPolicyDecisionCounts => ({
  total: decisions.length,
  allowed: decisions.filter((decision) => decision.decision === "allowed")
    .length,
  warned: decisions.filter((decision) => decision.decision === "warned")
    .length,
  denied: decisions.filter((decision) => decision.decision === "denied")
    .length,
});

export const createHarnessPolicyTrace = (
  options: CreateHarnessPolicyTraceOptions,
): HarnessPolicyTrace => {
  const decisions = [...(options.decisions ?? [])];
  return {
    type: "cf-harness.policy-trace",
    version: 1,
    generatedAt: options.generatedAt,
    runId: options.runId,
    cfcEnforcementMode: options.cfcEnforcementMode,
    ...(options.cfcPolicySnapshotPath !== undefined
      ? { cfcPolicySnapshotPath: options.cfcPolicySnapshotPath }
      : {}),
    ...(options.cfcPolicySnapshotDigest !== undefined
      ? { cfcPolicySnapshotDigest: options.cfcPolicySnapshotDigest }
      : {}),
    decisionCounts: countHarnessPolicyDecisions(decisions),
    decisions,
    ...(options.cfcInvocationContexts !== undefined
      ? { cfcInvocationContexts: [...options.cfcInvocationContexts] }
      : {}),
  };
};
