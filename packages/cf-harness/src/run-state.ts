import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "./contracts/cfc-invocation-context.ts";
import {
  appendHarnessCfcModelContextObservations as appendCfcModelContextObservations,
  type HarnessCfcModelContext,
  type HarnessCfcModelContextObservationInput,
} from "./contracts/cfc-model-context.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import type { HarnessPolicyEvent } from "./contracts/policy.ts";
import type {
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "./contracts/policy-trace.ts";
import type { HarnessRunManifest } from "./contracts/run-manifest.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import type {
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceReads,
  HarnessSkillScriptExecutions,
} from "./contracts/skill.ts";
import type { HarnessSubagentRunRef } from "./contracts/subagent.ts";
import type { ToolResultRef } from "./contracts/tool-result.ts";
import type {
  HarnessCapabilitySnapshot,
  HarnessFailureRecord,
} from "./diagnostics.ts";
import { selectPrimaryHarnessFailure } from "./diagnostics.ts";
import type {
  HarnessModelAuthSource,
  HarnessModelProviderId,
} from "./config.ts";

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
  modelProvider?: HarnessModelProviderId;
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwnerKey?: string;
  artifactRoot?: string;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
  skillRegistry?: HarnessSkillRegistry;
  skillRegistryPath?: string;
  skillActivations?: HarnessSkillActivations;
  skillActivationsPath?: string;
  skillResourceReads?: HarnessSkillResourceReads;
  skillResourceReadsPath?: string;
  skillScriptExecutions?: HarnessSkillScriptExecutions;
  skillScriptExecutionsPath?: string;
  transcriptPath?: string;
  runReportPath?: string;
  capabilitySnapshot?: HarnessCapabilitySnapshot;
  capabilitiesPath?: string;
  cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
  cfcPolicySnapshotPath?: string;
  policyTrace?: HarnessPolicyTrace;
  policyTracePath?: string;
  cfcModelContext?: HarnessCfcModelContext;
  cfcInvocationContexts?: HarnessCfcInvocationContext[];
  policyEvents: HarnessPolicyEvent[];
  policyDecisions?: HarnessPolicyDecisionRecord[];
  toolOutputs: ToolResultRef[];
  subagentRuns?: HarnessSubagentRunRef[];
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
  modelProvider?: HarnessModelProviderId;
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwnerKey?: string;
  artifactRoot?: string;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
  skillRegistry?: HarnessSkillRegistry;
  skillRegistryPath?: string;
  skillActivations?: HarnessSkillActivations;
  skillActivationsPath?: string;
  skillResourceReads?: HarnessSkillResourceReads;
  skillResourceReadsPath?: string;
  skillScriptExecutions?: HarnessSkillScriptExecutions;
  skillScriptExecutionsPath?: string;
  transcriptPath?: string;
  runReportPath?: string;
  capabilitySnapshot?: HarnessCapabilitySnapshot;
  capabilitiesPath?: string;
  cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
  cfcPolicySnapshotPath?: string;
  policyTrace?: HarnessPolicyTrace;
  policyTracePath?: string;
  cfcModelContext?: HarnessCfcModelContext;
  cfcInvocationContexts?: HarnessCfcInvocationContext[];
  policyDecisions?: HarnessPolicyDecisionRecord[];
  subagentRuns?: HarnessSubagentRunRef[];
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
    modelProvider: options.modelProvider ?? "openai-compatible-gateway",
    ...(options.modelAuthSource !== undefined
      ? { modelAuthSource: options.modelAuthSource }
      : {}),
    ...(options.credentialOwnerKey !== undefined
      ? { credentialOwnerKey: options.credentialOwnerKey }
      : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    ...(options.runManifest !== undefined
      ? { runManifest: options.runManifest }
      : {}),
    ...(options.runManifestPath !== undefined
      ? { runManifestPath: options.runManifestPath }
      : {}),
    ...(options.skillRegistry !== undefined
      ? { skillRegistry: options.skillRegistry }
      : {}),
    ...(options.skillRegistryPath !== undefined
      ? { skillRegistryPath: options.skillRegistryPath }
      : {}),
    ...(options.skillActivations !== undefined
      ? { skillActivations: options.skillActivations }
      : {}),
    ...(options.skillActivationsPath !== undefined
      ? { skillActivationsPath: options.skillActivationsPath }
      : {}),
    ...(options.skillResourceReads !== undefined
      ? { skillResourceReads: options.skillResourceReads }
      : {}),
    ...(options.skillResourceReadsPath !== undefined
      ? { skillResourceReadsPath: options.skillResourceReadsPath }
      : {}),
    ...(options.skillScriptExecutions !== undefined
      ? { skillScriptExecutions: options.skillScriptExecutions }
      : {}),
    ...(options.skillScriptExecutionsPath !== undefined
      ? { skillScriptExecutionsPath: options.skillScriptExecutionsPath }
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
    ...(options.cfcPolicySnapshot !== undefined
      ? { cfcPolicySnapshot: options.cfcPolicySnapshot }
      : {}),
    ...(options.cfcPolicySnapshotPath !== undefined
      ? { cfcPolicySnapshotPath: options.cfcPolicySnapshotPath }
      : {}),
    ...(options.policyTrace !== undefined
      ? { policyTrace: options.policyTrace }
      : {}),
    ...(options.policyTracePath !== undefined
      ? { policyTracePath: options.policyTracePath }
      : {}),
    ...(options.cfcModelContext !== undefined
      ? { cfcModelContext: structuredClone(options.cfcModelContext) }
      : {}),
    ...(options.cfcInvocationContexts !== undefined
      ? { cfcInvocationContexts: [...options.cfcInvocationContexts] }
      : {}),
    policyEvents: [],
    ...(options.policyDecisions !== undefined
      ? { policyDecisions: [...options.policyDecisions] }
      : {}),
    toolOutputs: [],
    ...(options.subagentRuns !== undefined
      ? { subagentRuns: [...options.subagentRuns] }
      : {}),
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

export const appendHarnessPolicyDecision = (
  state: HarnessRunState,
  decision: HarnessPolicyDecisionRecord,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  updatedAt: now,
  policyDecisions: [...(state.policyDecisions ?? []), decision],
});

export const appendHarnessCfcInvocationContext = (
  state: HarnessRunState,
  context: HarnessCfcInvocationContext,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  updatedAt: now,
  cfcInvocationContexts: [...(state.cfcInvocationContexts ?? []), context],
});

export const appendHarnessCfcModelContextObservations = (
  state: HarnessRunState,
  observations: readonly HarnessCfcModelContextObservationInput[],
  now = new Date().toISOString(),
): HarnessRunState => {
  const cfcModelContext = appendCfcModelContextObservations(
    state.cfcModelContext,
    observations,
    now,
  );
  if (cfcModelContext === state.cfcModelContext) {
    return state;
  }
  return {
    ...state,
    updatedAt: now,
    ...(cfcModelContext !== undefined ? { cfcModelContext } : {}),
  };
};

export const appendHarnessSubagentRun = (
  state: HarnessRunState,
  subagentRun: HarnessSubagentRunRef,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  updatedAt: now,
  subagentRuns: [...(state.subagentRuns ?? []), subagentRun],
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

export const setHarnessRunManifestPath = (
  state: HarnessRunState,
  runManifestPath: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  runManifestPath,
  updatedAt: now,
});

export const setHarnessSkillRegistry = (
  state: HarnessRunState,
  skillRegistry: HarnessSkillRegistry,
  skillRegistryPath?: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  skillRegistry,
  ...(skillRegistryPath !== undefined ? { skillRegistryPath } : {}),
  updatedAt: now,
});

export const setHarnessSkillActivations = (
  state: HarnessRunState,
  skillActivations: HarnessSkillActivations,
  skillActivationsPath?: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  skillActivations,
  ...(skillActivationsPath !== undefined ? { skillActivationsPath } : {}),
  updatedAt: now,
});

export const setHarnessSkillResourceReads = (
  state: HarnessRunState,
  skillResourceReads: HarnessSkillResourceReads,
  skillResourceReadsPath?: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  skillResourceReads,
  ...(skillResourceReadsPath !== undefined ? { skillResourceReadsPath } : {}),
  updatedAt: now,
});

export const setHarnessSkillScriptExecutions = (
  state: HarnessRunState,
  skillScriptExecutions: HarnessSkillScriptExecutions,
  skillScriptExecutionsPath?: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  skillScriptExecutions,
  ...(skillScriptExecutionsPath !== undefined
    ? { skillScriptExecutionsPath }
    : {}),
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

export const setHarnessCfcPolicySnapshot = (
  state: HarnessRunState,
  cfcPolicySnapshot: HarnessCfcPolicySnapshot,
  cfcPolicySnapshotPath?: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  cfcPolicySnapshot,
  ...(cfcPolicySnapshotPath !== undefined ? { cfcPolicySnapshotPath } : {}),
  updatedAt: now,
});

export const setHarnessPolicyTrace = (
  state: HarnessRunState,
  policyTrace: HarnessPolicyTrace,
  policyTracePath?: string,
  now = new Date().toISOString(),
): HarnessRunState => ({
  ...state,
  policyTrace,
  ...(policyTracePath !== undefined ? { policyTracePath } : {}),
  updatedAt: now,
});
