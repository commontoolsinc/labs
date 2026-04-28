import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessFailureRecord } from "../diagnostics.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";

export const DEFAULT_SUBAGENT_PROFILE = "default" as const;
export const DEFAULT_SUBAGENT_MAX_MODEL_TURNS = 8;
export const MAX_SUBAGENT_MAX_MODEL_TURNS = 16;
export const DEFAULT_SUBAGENT_ALLOWED_TOOL_IDS = [
  "bash",
  "read_file",
  "write_file",
] as const satisfies readonly BuiltinToolId[];

export type HarnessSubagentProfile = typeof DEFAULT_SUBAGENT_PROFILE;
export type HarnessSubagentRunStatus = "completed" | "failed";

export interface HarnessSubagentInputSummary {
  type: "cf-harness.subagent-input-summary";
  goalBytes: number;
  goalDigest: string;
  contextBytes?: number;
  contextDigest?: string;
}

export interface HarnessSubagentRunManifest {
  type: "cf-harness.subagent-run-manifest";
  version: 1;
  parentRunId: string;
  parentToolCallId: string;
  childRunId: string;
  profile: HarnessSubagentProfile;
  depth: 1;
  cfcEnforcementMode: CfcEnforcementMode;
  model: string;
  allowedToolIds: readonly BuiltinToolId[];
  maxModelTurns: number;
  createdAt: string;
  inputSummary: HarnessSubagentInputSummary;
}

export interface HarnessSubagentRunStateSummary {
  status: string;
  cfcEnforcementMode: CfcEnforcementMode;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  artifactRoot?: string;
  transcriptPath?: string;
  runReportPath?: string;
  terminalReason?: string;
  policyEventCounts: {
    total: number;
    warnings: number;
    denied: number;
  };
  failureCount: number;
  primaryFailure?: HarnessFailureRecord;
}

export interface HarnessSubagentResult {
  type: "cf-harness.subagent-result";
  childRunId: string;
  status: HarnessSubagentRunStatus;
  summary: string;
  model: string;
  modelTurns: number;
  runState: HarnessSubagentRunStateSummary;
  manifest: HarnessSubagentRunManifest;
}

export interface HarnessSubagentRunRef {
  type: "cf-harness.subagent-run-ref";
  parentToolCallId: string;
  outputId?: string;
  childRunId: string;
  status: HarnessSubagentRunStatus;
  summary: string;
  manifest: HarnessSubagentRunManifest;
  runState: HarnessSubagentRunStateSummary;
}

export interface DelegateTaskToolInput {
  goal: string;
  context?: string;
  maxModelTurns?: number;
}

export interface DelegateTaskToolOutput {
  type: "cf-harness.delegate-task-output";
  outputId: string;
  subagent: HarnessSubagentResult;
}
