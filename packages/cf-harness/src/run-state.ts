import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessPolicyEvent } from "./contracts/policy.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import type { ToolResultRef } from "./contracts/tool-result.ts";
import type {
  HarnessCapabilitySnapshot,
  HarnessFailureRecord,
} from "./diagnostics.ts";
import { selectPrimaryHarnessFailure } from "./diagnostics.ts";

export type HarnessRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type HarnessRunTerminalReason =
  | "assistant_completed"
  | "tool_completed"
  | "tool_error"
  | "max_model_turns"
  | "prompt_loop_error"
  | "process_interrupted";

export interface HarnessRunState {
  runId: string;
  status: HarnessRunStatus;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  terminalReason?: HarnessRunTerminalReason;
  cfcEnforcementMode: CfcEnforcementMode;
  promptSlotBinding?: PromptSlotBinding;
  currentDir: string;
  model?: string;
  artifactRoot?: string;
  transcriptPath?: string;
  runReportPath?: string;
  capabilitySnapshot?: HarnessCapabilitySnapshot;
  capabilitiesPath?: string;
  policyEvents: HarnessPolicyEvent[];
  toolOutputs: ToolResultRef[];
  failureRecords?: HarnessFailureRecord[];
  primaryFailure?: HarnessFailureRecord;
}

export interface CreateHarnessRunStateOptions {
  runId?: string;
  status?: HarnessRunStatus;
  endedAt?: string;
  terminalReason?: HarnessRunTerminalReason;
  cfcEnforcementMode: CfcEnforcementMode;
  promptSlotBinding?: PromptSlotBinding;
  currentDir: string;
  model?: string;
  artifactRoot?: string;
  transcriptPath?: string;
  runReportPath?: string;
  capabilitySnapshot?: HarnessCapabilitySnapshot;
  capabilitiesPath?: string;
  failureRecords?: HarnessFailureRecord[];
  primaryFailure?: HarnessFailureRecord;
  now?: string;
}

export const createHarnessRunState = (
  options: CreateHarnessRunStateOptions,
): HarnessRunState => {
  const now = options.now ?? new Date().toISOString();
  return {
    runId: options.runId ?? crypto.randomUUID(),
    status: options.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    ...(options.endedAt !== undefined ? { endedAt: options.endedAt } : {}),
    ...(options.terminalReason !== undefined
      ? { terminalReason: options.terminalReason }
      : {}),
    cfcEnforcementMode: options.cfcEnforcementMode,
    ...(options.promptSlotBinding !== undefined
      ? { promptSlotBinding: options.promptSlotBinding }
      : {}),
    currentDir: options.currentDir,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    ...(options.transcriptPath !== undefined
      ? { transcriptPath: options.transcriptPath }
      : {}),
    ...(options.runReportPath !== undefined
      ? { runReportPath: options.runReportPath }
      : {}),
    ...(options.capabilitySnapshot !== undefined
      ? { capabilitySnapshot: options.capabilitySnapshot }
      : {}),
    ...(options.capabilitiesPath !== undefined
      ? { capabilitiesPath: options.capabilitiesPath }
      : {}),
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [...(options.failureRecords ?? [])],
    ...(options.primaryFailure !== undefined
      ? { primaryFailure: options.primaryFailure }
      : {}),
  };
};

export const setHarnessRunStatus = (
  state: HarnessRunState,
  status: HarnessRunStatus,
  now = new Date().toISOString(),
  terminalReason?: HarnessRunTerminalReason,
): HarnessRunState => {
  const base = {
    ...state,
    status,
    updatedAt: now,
  };
  if (status === "completed" || status === "failed") {
    return {
      ...base,
      endedAt: now,
      ...(terminalReason !== undefined ? { terminalReason } : {}),
    };
  }
  const { endedAt: _endedAt, terminalReason: _terminalReason, ...nonTerminal } =
    base;
  return {
    ...nonTerminal,
  };
};

export const appendHarnessToolOutput = (
  state: HarnessRunState,
  output: ToolResultRef,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  updatedAt: now,
  toolOutputs: [...state.toolOutputs, output],
});

export const appendHarnessPolicyEvent = (
  state: HarnessRunState,
  event: HarnessPolicyEvent,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  updatedAt: now,
  policyEvents: [...state.policyEvents, event],
});

export const setHarnessPromptSlotBinding = (
  state: HarnessRunState,
  promptSlotBinding: PromptSlotBinding,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  promptSlotBinding,
  updatedAt: now,
});

export const appendHarnessFailureRecord = (
  state: HarnessRunState,
  failure: HarnessFailureRecord,
  now = new Date().toISOString(),
): HarnessRunState => {
  const failureRecords = [...(state.failureRecords ?? []), failure];
  const primaryFailure = selectPrimaryHarnessFailure(failureRecords);
  return {
    ...state,
    updatedAt: now,
    failureRecords,
    ...(primaryFailure !== undefined ? { primaryFailure } : {}),
  };
};

export const setHarnessRunCurrentDir = (
  state: HarnessRunState,
  currentDir: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  currentDir,
  updatedAt: now,
});

export const setHarnessTranscriptPath = (
  state: HarnessRunState,
  transcriptPath: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  transcriptPath,
  updatedAt: now,
});

export const setHarnessRunReportPath = (
  state: HarnessRunState,
  runReportPath: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  runReportPath,
  updatedAt: now,
});

export const setHarnessCapabilitySnapshot = (
  state: HarnessRunState,
  capabilitySnapshot: HarnessCapabilitySnapshot,
  capabilitiesPath?: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  capabilitySnapshot,
  ...(capabilitiesPath !== undefined ? { capabilitiesPath } : {}),
  updatedAt: now,
});
