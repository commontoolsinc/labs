import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { JSONSchema } from "@commonfabric/api";
import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  type LLMNativeModelToolId,
} from "@commonfabric/llm/types";
import type { HarnessFailureRecord } from "../diagnostics.ts";
import type { HarnessModelProviderId } from "../config.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillScriptExecutionTarget,
} from "./skill.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";

export const DEFAULT_SUBAGENT_PROFILE = "default" as const;
export const BROWSER_SUBAGENT_PROFILE = "browser" as const;
export const WEB_FETCH_SUBAGENT_PROFILE = "web_fetch" as const;
export const WEB_SEARCH_SUBAGENT_PROFILE = "web_search" as const;
export const WEB_SEARCH_SUBAGENT_MODEL = "gemini-3.5-flash" as const;
export const DEFAULT_SUBAGENT_MAX_MODEL_TURNS = 8;
export const MAX_SUBAGENT_MAX_MODEL_TURNS = 64;
export const DEFAULT_SUBAGENT_RETURN_CHANNEL =
  "summary-and-sanitized-state" as const;
export const DEFAULT_SUBAGENT_ALLOWED_TOOL_IDS = [
  "bash",
  "read_file",
  "view_image",
  "edit_file",
  "write_file",
] as const satisfies readonly BuiltinToolId[];
export const BROWSER_SUBAGENT_ALLOWED_TOOL_IDS = [
  "bash-no-sandbox",
  "read_file",
  "view_image",
  "read_skill_resource",
  "run_skill_script",
] as const satisfies readonly BuiltinToolId[];
export const WEB_FETCH_SUBAGENT_ALLOWED_TOOL_IDS = [
  "web_fetch",
] as const satisfies readonly BuiltinToolId[];
export const WEB_SEARCH_SUBAGENT_ALLOWED_TOOL_IDS =
  [] as const satisfies readonly BuiltinToolId[];
export const NO_HOST_TOOL_IDS = [] as const satisfies readonly BuiltinToolId[];
export const BROWSER_SUBAGENT_HOST_TOOL_IDS = [
  "bash-no-sandbox",
] as const satisfies readonly BuiltinToolId[];
export const BROWSER_SUBAGENT_SKILL_NAMES = [
  "agent-browser",
] as const satisfies readonly string[];
export const BROWSER_SUBAGENT_ALLOWED_SKILL_SCRIPTS = [
  { skill: "agent-browser", path: "scripts/form-automation.sh" },
  { skill: "agent-browser", path: "scripts/capture-workflow.sh" },
] as const satisfies readonly HarnessAllowedSkillScript[];
export const WEB_SEARCH_SUBAGENT_NATIVE_MODEL_TOOL_IDS = [
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
] as const satisfies readonly HarnessNativeModelToolId[];

export const HARNESS_SUBAGENT_PROFILES = [
  DEFAULT_SUBAGENT_PROFILE,
  BROWSER_SUBAGENT_PROFILE,
  WEB_FETCH_SUBAGENT_PROFILE,
  WEB_SEARCH_SUBAGENT_PROFILE,
] as const;

export type HarnessSubagentProfile = typeof HARNESS_SUBAGENT_PROFILES[number];
export type HarnessSubagentModelSource = "parent" | "profile";
export type HarnessNativeModelToolId = LLMNativeModelToolId;
export type HarnessSubagentRunStatus = "completed" | "failed";
export type HarnessSubagentReturnChannel =
  typeof DEFAULT_SUBAGENT_RETURN_CHANNEL;

export interface HarnessSubagentReturnPolicy {
  type: "cf-harness.subagent-return-policy";
  channel: HarnessSubagentReturnChannel;
  includeSummary: true;
  includeSanitizedRunState: true;
  includeManifest: true;
  includeTranscript: false;
  includeRawFailureRecords: false;
}

export interface HarnessSubagentProfileConfig {
  type: "cf-harness.subagent-profile-config";
  profile: HarnessSubagentProfile;
  allowedToolIds: readonly BuiltinToolId[];
  hostToolIds: readonly BuiltinToolId[];
  modelOverride?: string;
  nativeModelToolIds?: readonly HarnessNativeModelToolId[];
  skillNames?: readonly string[];
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget?: HarnessSkillScriptExecutionTarget;
  maxModelTurns: number;
  returnPolicy: HarnessSubagentReturnPolicy;
}

export const DEFAULT_SUBAGENT_RETURN_POLICY: HarnessSubagentReturnPolicy = {
  type: "cf-harness.subagent-return-policy",
  channel: DEFAULT_SUBAGENT_RETURN_CHANNEL,
  includeSummary: true,
  includeSanitizedRunState: true,
  includeManifest: true,
  includeTranscript: false,
  includeRawFailureRecords: false,
};

export const DEFAULT_SUBAGENT_PROFILE_CONFIG: HarnessSubagentProfileConfig = {
  type: "cf-harness.subagent-profile-config",
  profile: DEFAULT_SUBAGENT_PROFILE,
  allowedToolIds: DEFAULT_SUBAGENT_ALLOWED_TOOL_IDS,
  hostToolIds: NO_HOST_TOOL_IDS,
  maxModelTurns: DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
  returnPolicy: DEFAULT_SUBAGENT_RETURN_POLICY,
};

export const BROWSER_SUBAGENT_PROFILE_CONFIG: HarnessSubagentProfileConfig = {
  type: "cf-harness.subagent-profile-config",
  profile: BROWSER_SUBAGENT_PROFILE,
  allowedToolIds: BROWSER_SUBAGENT_ALLOWED_TOOL_IDS,
  hostToolIds: BROWSER_SUBAGENT_HOST_TOOL_IDS,
  skillNames: BROWSER_SUBAGENT_SKILL_NAMES,
  allowedSkillScripts: BROWSER_SUBAGENT_ALLOWED_SKILL_SCRIPTS,
  skillScriptExecutionTarget: "host",
  maxModelTurns: DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
  returnPolicy: DEFAULT_SUBAGENT_RETURN_POLICY,
};

export const WEB_FETCH_SUBAGENT_PROFILE_CONFIG: HarnessSubagentProfileConfig = {
  type: "cf-harness.subagent-profile-config",
  profile: WEB_FETCH_SUBAGENT_PROFILE,
  allowedToolIds: WEB_FETCH_SUBAGENT_ALLOWED_TOOL_IDS,
  hostToolIds: NO_HOST_TOOL_IDS,
  maxModelTurns: DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
  returnPolicy: DEFAULT_SUBAGENT_RETURN_POLICY,
};

export const WEB_SEARCH_SUBAGENT_PROFILE_CONFIG: HarnessSubagentProfileConfig =
  {
    type: "cf-harness.subagent-profile-config",
    profile: WEB_SEARCH_SUBAGENT_PROFILE,
    allowedToolIds: WEB_SEARCH_SUBAGENT_ALLOWED_TOOL_IDS,
    hostToolIds: NO_HOST_TOOL_IDS,
    modelOverride: WEB_SEARCH_SUBAGENT_MODEL,
    nativeModelToolIds: WEB_SEARCH_SUBAGENT_NATIVE_MODEL_TOOL_IDS,
    maxModelTurns: DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
    returnPolicy: DEFAULT_SUBAGENT_RETURN_POLICY,
  };

export const isHarnessSubagentProfile = (
  input: string,
): input is HarnessSubagentProfile =>
  (HARNESS_SUBAGENT_PROFILES as readonly string[]).includes(input);

export const getHarnessSubagentProfileConfig = (
  profile: HarnessSubagentProfile,
): HarnessSubagentProfileConfig => {
  switch (profile) {
    case DEFAULT_SUBAGENT_PROFILE:
      return DEFAULT_SUBAGENT_PROFILE_CONFIG;
    case BROWSER_SUBAGENT_PROFILE:
      return BROWSER_SUBAGENT_PROFILE_CONFIG;
    case WEB_FETCH_SUBAGENT_PROFILE:
      return WEB_FETCH_SUBAGENT_PROFILE_CONFIG;
    case WEB_SEARCH_SUBAGENT_PROFILE:
      return WEB_SEARCH_SUBAGENT_PROFILE_CONFIG;
  }
};

export interface HarnessSubagentInputSummary {
  type: "cf-harness.subagent-input-summary";
  goalBytes: number;
  goalDigest: string;
  contextBytes?: number;
  contextDigest?: string;
  returnSchemaBytes?: number;
  returnSchemaDigest?: string;
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
  modelProvider?: HarnessModelProviderId;
  model: string;
  modelSource?: HarnessSubagentModelSource;
  allowedToolIds: readonly BuiltinToolId[];
  hostToolIds: readonly BuiltinToolId[];
  nativeModelToolIds?: readonly HarnessNativeModelToolId[];
  skillNames?: readonly string[];
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget?: HarnessSkillScriptExecutionTarget;
  maxModelTurns: number;
  returnPolicy: HarnessSubagentReturnPolicy;
  createdAt: string;
  inputSummary: HarnessSubagentInputSummary;
}

export interface HarnessSubagentFailureSummary extends
  Pick<
    HarnessFailureRecord,
    | "kind"
    | "source"
    | "toolId"
    | "toolCallId"
    | "outputId"
    | "commandName"
    | "exitCode"
  > {
  type: "cf-harness.subagent-failure-summary";
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
  primaryFailure?: HarnessSubagentFailureSummary;
}

export interface HarnessSubagentStructuredReturn {
  type: "cf-harness.subagent-structured-return";
  status: "valid" | "invalid";
  schemaDigest: string;
  rawOutputId: string;
  rawArtifactPath?: string;
  value?: unknown;
  linkedStringCount?: number;
  validationError?: string;
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
  structuredReturn?: HarnessSubagentStructuredReturn;
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
  structuredReturn?: HarnessSubagentStructuredReturn;
}

export interface DelegateTaskToolInput {
  goal: string;
  profile: HarnessSubagentProfile;
  context?: string;
  maxModelTurns?: number;
  returnSchema?: JSONSchema;
}

export interface DelegateTaskToolOutput {
  type: "cf-harness.delegate-task-output";
  outputId: string;
  subagent: HarnessSubagentResult;
}
