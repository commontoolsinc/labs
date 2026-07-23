import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessCfcPolicySnapshot } from "./cfc-policy-snapshot.ts";
import type { HarnessFailureRecord } from "../diagnostics.ts";
import type { HarnessPolicyEvent, HarnessToolInputSummary } from "./policy.ts";
import type {
  HarnessPolicyDecisionCounts,
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "./policy-trace.ts";
import { countHarnessPolicyDecisions } from "./policy-trace.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessSubagentRunRef } from "./subagent.ts";
import type { HarnessToolEffectClass } from "./tool-descriptor.ts";
import type { HarnessTranscriptMessage } from "./transcript.ts";
import type { ToolResultRef } from "./tool-result.ts";
import type { OpenAIChatCompletionAttemptDiagnostic } from "../gateway/openai-client.ts";
import type { HarnessModelAttemptDiagnostic } from "../model/client.ts";
import type {
  HarnessModelAuthSource,
  HarnessModelProviderId,
} from "../config.ts";

export type HarnessToolPolicyDecision = "allowed" | "warned" | "denied";
export type HarnessToolExecutionStatus = "completed" | "failed" | "not-run";
export type HarnessRunTimelineKind =
  | "run_started"
  | "transcript_message"
  | "tool_activity"
  | "subagent_run"
  | "policy_event"
  | "failure_record"
  | "run_finished";

export interface HarnessToolActivity {
  type: "cf-harness.tool-activity";
  runId: string;
  sequence: number;
  startedAt: string;
  endedAt: string;
  toolCallId: string;
  toolId: string;
  effectClass: HarnessToolEffectClass;
  cfcEnforcementMode: CfcEnforcementMode;
  policyDecision: HarnessToolPolicyDecision;
  executionStatus: HarnessToolExecutionStatus;
  promptSlot?: PromptSlotBinding;
  toolInputSummary?: HarnessToolInputSummary;
  policyEventIndexes?: number[];
  resultRef?: ToolResultRef;
  errorDetail?: string;
}

export interface HarnessGatewayAttempt
  extends OpenAIChatCompletionAttemptDiagnostic {
  runId: string;
  sequence: number;
  modelTurn: number;
}

export interface HarnessModelAttempt extends HarnessModelAttemptDiagnostic {
  runId: string;
  sequence: number;
  modelTurn: number;
}

export interface HarnessRunTimelineEntry {
  type: "cf-harness.timeline-entry";
  sequence: number;
  at: string;
  kind: HarnessRunTimelineKind;
  endedAt?: string;
  status?: string;
  terminalReason?: string;
  transcriptIndex?: number;
  role?: HarnessTranscriptMessage["role"];
  modelTurn?: number;
  toolCallIds?: string[];
  toolCallId?: string;
  toolId?: string;
  toolActivitySequence?: number;
  policyDecision?: HarnessToolPolicyDecision;
  executionStatus?: HarnessToolExecutionStatus;
  policyEventIndex?: number;
  severity?: HarnessPolicyEvent["severity"];
  failureRecordIndex?: number;
  failureKind?: string;
  source?: string;
  childRunId?: string;
  subagentStatus?: string;
}

export type HarnessRunTimelineEntryInput = Omit<
  HarnessRunTimelineEntry,
  "type" | "sequence"
>;

export interface HarnessRunReport {
  type: "cf-harness.run-report";
  runId: string;
  generatedAt: string;
  status: string;
  model: string;
  modelProvider: HarnessModelProviderId;
  modelAuthSource: HarnessModelAuthSource;
  modelTurns: number;
  cfcEnforcementMode: CfcEnforcementMode;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  terminalReason?: string;
  finalAssistantText?: string;
  artifactRoot?: string;
  transcriptPath?: string;
  promptSlotBinding?: PromptSlotBinding;
  cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
  policyTrace?: HarnessPolicyTrace;
  policyTracePath?: string;
  primaryFailure?: HarnessFailureRecord;
  failureRecords?: HarnessFailureRecord[];
  policyEventCounts: {
    total: number;
    warnings: number;
    denied: number;
  };
  policyDecisionCounts: HarnessPolicyDecisionCounts;
  policyEvents: HarnessPolicyEvent[];
  policyDecisions: HarnessPolicyDecisionRecord[];
  timeline: HarnessRunTimelineEntry[];
  toolActivity: HarnessToolActivity[];
  gatewayAttempts?: HarnessGatewayAttempt[];
  modelAttempts?: HarnessModelAttempt[];
  toolOutputs: ToolResultRef[];
  subagentRuns?: HarnessSubagentRunRef[];
}

export interface CreateHarnessRunReportOptions {
  runState: {
    runId: string;
    status: string;
    createdAt?: string;
    updatedAt: string;
    endedAt?: string;
    terminalReason?: string;
    cfcEnforcementMode: CfcEnforcementMode;
    artifactRoot?: string;
    transcriptPath?: string;
    promptSlotBinding?: PromptSlotBinding;
    cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
    policyTrace?: HarnessPolicyTrace;
    policyTracePath?: string;
    primaryFailure?: HarnessFailureRecord;
    failureRecords?: HarnessFailureRecord[];
    policyEvents: HarnessPolicyEvent[];
    policyDecisions?: HarnessPolicyDecisionRecord[];
    toolOutputs: ToolResultRef[];
    modelProvider?: HarnessModelProviderId;
    modelAuthSource?: HarnessModelAuthSource;
    subagentRuns?: HarnessSubagentRunRef[];
  };
  model: string;
  modelTurns: number;
  finalAssistantText?: string;
  timeline?: readonly HarnessRunTimelineEntryInput[];
  toolActivity: readonly HarnessToolActivity[];
  gatewayAttempts?: readonly HarnessGatewayAttempt[];
  modelAttempts?: readonly HarnessModelAttempt[];
}

export const createHarnessRunTimeline = (
  options: Pick<CreateHarnessRunReportOptions, "runState" | "toolActivity"> & {
    timeline?: readonly HarnessRunTimelineEntryInput[];
  },
): HarnessRunTimelineEntry[] => {
  let insertionOrder = 0;
  const entries: Array<HarnessRunTimelineEntryInput & { order: number }> = [];
  const push = (entry: HarnessRunTimelineEntryInput): void => {
    if (!entry.at) {
      return;
    }
    insertionOrder += 1;
    entries.push({ ...entry, order: insertionOrder });
  };

  if (options.runState.createdAt !== undefined) {
    push({
      kind: "run_started",
      at: options.runState.createdAt,
      status: "created",
    });
  }
  for (const entry of options.timeline ?? []) {
    push(entry);
  }
  for (const activity of options.toolActivity) {
    push({
      kind: "tool_activity",
      at: activity.startedAt,
      endedAt: activity.endedAt,
      toolActivitySequence: activity.sequence,
      toolCallId: activity.toolCallId,
      toolId: activity.toolId,
      policyDecision: activity.policyDecision,
      executionStatus: activity.executionStatus,
    });
  }
  for (const subagentRun of options.runState.subagentRuns ?? []) {
    push({
      kind: "subagent_run",
      at: subagentRun.runState.endedAt ?? subagentRun.runState.updatedAt ??
        subagentRun.manifest.createdAt,
      toolCallId: subagentRun.parentToolCallId,
      childRunId: subagentRun.childRunId,
      subagentStatus: subagentRun.status,
      status: subagentRun.runState.status,
      terminalReason: subagentRun.runState.terminalReason,
    });
  }
  for (
    const [policyEventIndex, event] of options.runState.policyEvents.entries()
  ) {
    push({
      kind: "policy_event",
      at: event.at,
      policyEventIndex,
      severity: event.severity,
      toolCallId: event.toolCallId,
      toolId: event.toolId,
    });
  }
  for (
    const [failureRecordIndex, failure]
      of (options.runState.failureRecords ?? []).entries()
  ) {
    push({
      kind: "failure_record",
      at: failure.at,
      failureRecordIndex,
      failureKind: failure.kind,
      source: failure.source,
      toolId: failure.toolId,
    });
  }
  if (options.runState.endedAt !== undefined) {
    push({
      kind: "run_finished",
      at: options.runState.endedAt,
      status: options.runState.status,
      ...(options.runState.terminalReason !== undefined
        ? { terminalReason: options.runState.terminalReason }
        : {}),
    });
  }

  return entries
    .sort((left, right) =>
      left.at === right.at ? left.order - right.order : left.at.localeCompare(
        right.at,
      )
    )
    .map(({ order: _order, ...entry }, index) => ({
      type: "cf-harness.timeline-entry",
      sequence: index + 1,
      ...entry,
    }));
};

export const createHarnessRunReport = (
  options: CreateHarnessRunReportOptions,
): HarnessRunReport => {
  const warnings =
    options.runState.policyEvents.filter((event) =>
      event.severity === "warning"
    ).length;
  const denied =
    options.runState.policyEvents.filter((event) => event.severity === "denied")
      .length;
  const policyDecisions = [...(options.runState.policyDecisions ?? [])];
  return {
    type: "cf-harness.run-report",
    runId: options.runState.runId,
    generatedAt: options.runState.updatedAt,
    status: options.runState.status,
    model: options.model,
    modelProvider: options.runState.modelProvider ??
      "openai-compatible-gateway",
    modelAuthSource: options.runState.modelAuthSource ??
      (options.runState.modelProvider === "openai-codex"
        ? "owner-bound-oauth"
        : "api-key"),
    modelTurns: options.modelTurns,
    cfcEnforcementMode: options.runState.cfcEnforcementMode,
    ...(options.runState.createdAt !== undefined
      ? { createdAt: options.runState.createdAt }
      : {}),
    updatedAt: options.runState.updatedAt,
    ...(options.runState.endedAt !== undefined
      ? { endedAt: options.runState.endedAt }
      : {}),
    ...(options.runState.terminalReason !== undefined
      ? { terminalReason: options.runState.terminalReason }
      : {}),
    ...(options.finalAssistantText !== undefined
      ? { finalAssistantText: options.finalAssistantText }
      : {}),
    ...(options.runState.artifactRoot !== undefined
      ? { artifactRoot: options.runState.artifactRoot }
      : {}),
    ...(options.runState.transcriptPath !== undefined
      ? { transcriptPath: options.runState.transcriptPath }
      : {}),
    ...(options.runState.promptSlotBinding !== undefined
      ? { promptSlotBinding: options.runState.promptSlotBinding }
      : {}),
    ...(options.runState.cfcPolicySnapshot !== undefined
      ? { cfcPolicySnapshot: options.runState.cfcPolicySnapshot }
      : {}),
    ...(options.runState.policyTrace !== undefined
      ? { policyTrace: options.runState.policyTrace }
      : {}),
    ...(options.runState.policyTracePath !== undefined
      ? { policyTracePath: options.runState.policyTracePath }
      : {}),
    ...(options.runState.primaryFailure !== undefined
      ? { primaryFailure: options.runState.primaryFailure }
      : {}),
    ...(options.runState.failureRecords !== undefined
      ? { failureRecords: options.runState.failureRecords }
      : {}),
    policyEventCounts: {
      total: options.runState.policyEvents.length,
      warnings,
      denied,
    },
    policyDecisionCounts: countHarnessPolicyDecisions(policyDecisions),
    policyEvents: [...options.runState.policyEvents],
    policyDecisions,
    timeline: createHarnessRunTimeline({
      runState: options.runState,
      timeline: options.timeline,
      toolActivity: options.toolActivity,
    }),
    toolActivity: [...options.toolActivity],
    ...((options.gatewayAttempts?.length ?? 0) > 0
      ? { gatewayAttempts: [...(options.gatewayAttempts ?? [])] }
      : {}),
    ...((options.modelAttempts?.length ?? 0) > 0
      ? { modelAttempts: [...(options.modelAttempts ?? [])] }
      : {}),
    toolOutputs: [...options.runState.toolOutputs],
    ...(options.runState.subagentRuns !== undefined &&
        options.runState.subagentRuns.length > 0
      ? { subagentRuns: [...options.runState.subagentRuns] }
      : {}),
  };
};
