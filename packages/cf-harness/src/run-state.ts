import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "./contracts/cfc-invocation-context.ts";
import {
  appendHarnessCfcModelContextObservations as appendCfcModelContextObservations,
  type HarnessCfcModelContext,
  type HarnessCfcModelContextObservationInput,
} from "./contracts/cfc-model-context.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
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
import type {
  HarnessSubagentLineage,
  HarnessSubagentRunRef,
} from "./contracts/subagent.ts";
import type { ToolResultRef } from "./contracts/tool-result.ts";
import type {
  HarnessCapabilitySnapshot,
  HarnessFailureRecord,
} from "./diagnostics.ts";
import { selectPrimaryHarnessFailure } from "./diagnostics.ts";
import type {
  HarnessHandleMode,
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
  /**
   * The handle mode the run was created with, recorded so a resume inherits
   * it instead of downgrading to the default. Absent on runs created in
   * `disabled` mode.
   */
  handleMode?: HarnessHandleMode;
  handleTable?: HarnessHandleTable;
  policyEvents: HarnessPolicyEvent[];
  policyDecisions?: HarnessPolicyDecisionRecord[];
  toolOutputs: ToolResultRef[];
  lineage?: HarnessSubagentLineage;
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
  handleMode?: HarnessHandleMode;
  handleTable?: HarnessHandleTable;
  policyDecisions?: HarnessPolicyDecisionRecord[];
  lineage?: HarnessSubagentLineage;
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
    ...(options.handleMode !== undefined
      ? { handleMode: options.handleMode }
      : {}),
    ...(options.handleTable !== undefined
      ? { handleTable: structuredClone(options.handleTable) }
      : {}),
    ...(options.lineage !== undefined
      ? { lineage: structuredClone(options.lineage) }
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

// Applies an immutable update to a run state and stamps `updatedAt`. A key
// whose value is undefined is left out of the result instead of being written
// as an explicit undefined, so a caller can pass an optional artifact path
// through without testing it first.
export const patchHarnessRunState = (
  state: HarnessRunState,
  patch: Partial<HarnessRunState>,
  now = new Date().toISOString(),
): HarnessRunState => {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  return Object.assign({ ...state }, defined, { updatedAt: now });
};

type HarnessRunStateListField = {
  [K in keyof HarnessRunState]-?: NonNullable<HarnessRunState[K]> extends
    readonly unknown[] ? K : never;
}[keyof HarnessRunState];

type HarnessRunStateListEntry<K extends HarnessRunStateListField> =
  NonNullable<HarnessRunState[K]> extends readonly (infer TEntry)[] ? TEntry
    : never;

// Appends one entry to a list-valued run state field, treating an absent list
// as empty.
export const appendToHarnessRunState = <K extends HarnessRunStateListField>(
  state: HarnessRunState,
  field: K,
  entry: HarnessRunStateListEntry<K>,
  now = new Date().toISOString(),
): HarnessRunState =>
  patchHarnessRunState(
    state,
    { [field]: [...(state[field] ?? []), entry] } as Partial<HarnessRunState>,
    now,
  );

export const setHarnessRunStatus = (
  state: HarnessRunState,
  status: HarnessRunStatus,
  now = new Date().toISOString(),
  terminalReason?: HarnessRunTerminalReason,
): HarnessRunState => {
  if (status === "completed" || status === "failed") {
    return patchHarnessRunState(
      state,
      { status, endedAt: now, terminalReason },
      now,
    );
  }
  const { endedAt: _endedAt, terminalReason: _terminalReason, ...nonTerminal } =
    state;
  return patchHarnessRunState(nonTerminal, { status }, now);
};

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
  return patchHarnessRunState(state, { cfcModelContext }, now);
};

export const setHarnessSubagentRun = (
  state: HarnessRunState,
  subagentRun: HarnessSubagentRunRef,
  now = new Date().toISOString(),
): HarnessRunState => {
  const existingIndex =
    state.subagentRuns?.findIndex((existing) =>
      existing.childRunId === subagentRun.childRunId
    ) ?? -1;
  const subagentRuns = [...(state.subagentRuns ?? [])];
  if (existingIndex >= 0) {
    subagentRuns[existingIndex] = subagentRun;
  } else {
    subagentRuns.push(subagentRun);
  }
  return patchHarnessRunState(state, { subagentRuns }, now);
};

export const appendHarnessFailureRecord = (
  state: HarnessRunState,
  failure: HarnessFailureRecord,
  now = new Date().toISOString(),
): HarnessRunState => {
  const failureRecords = [...(state.failureRecords ?? []), failure];
  return patchHarnessRunState(
    state,
    {
      failureRecords,
      primaryFailure: selectPrimaryHarnessFailure(failureRecords),
    },
    now,
  );
};
