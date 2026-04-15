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
  toolOutputs: ToolResultRef[];
}

export interface CreateHarnessRunStateOptions {
  runId?: string;
  status?: HarnessRunStatus;
  cfcEnforcementMode: CfcEnforcementMode;
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
    toolOutputs: [],
  };
};
