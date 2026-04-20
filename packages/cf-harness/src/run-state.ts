import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessPolicyEvent } from "./contracts/policy.ts";
import type { ToolResultRef } from "./contracts/tool-result.ts";

export type HarnessRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface HarnessRunState {
  runId: string;
  status: HarnessRunStatus;
  createdAt: string;
  updatedAt: string;
  cfcEnforcementMode: CfcEnforcementMode;
  currentDir: string;
  model?: string;
  artifactRoot?: string;
  transcriptPath?: string;
  policyEvents: HarnessPolicyEvent[];
  toolOutputs: ToolResultRef[];
}

export interface CreateHarnessRunStateOptions {
  runId?: string;
  status?: HarnessRunStatus;
  cfcEnforcementMode: CfcEnforcementMode;
  currentDir: string;
  model?: string;
  artifactRoot?: string;
  transcriptPath?: string;
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
    cfcEnforcementMode: options.cfcEnforcementMode,
    currentDir: options.currentDir,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    ...(options.transcriptPath !== undefined
      ? { transcriptPath: options.transcriptPath }
      : {}),
    policyEvents: [],
    toolOutputs: [],
  };
};

export const setHarnessRunStatus = (
  state: HarnessRunState,
  status: HarnessRunStatus,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  status,
  updatedAt: now,
});

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
