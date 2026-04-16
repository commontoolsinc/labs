import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
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
  artifactRoot?: string;
  transcriptPath?: string;
  toolOutputs: ToolResultRef[];
}

export interface CreateHarnessRunStateOptions {
  runId?: string;
  status?: HarnessRunStatus;
  cfcEnforcementMode: CfcEnforcementMode;
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
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    ...(options.transcriptPath !== undefined
      ? { transcriptPath: options.transcriptPath }
      : {}),
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

export const setHarnessTranscriptPath = (
  state: HarnessRunState,
  transcriptPath: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  transcriptPath,
  updatedAt: now,
});
