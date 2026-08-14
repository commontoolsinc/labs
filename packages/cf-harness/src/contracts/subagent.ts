import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { JSONSchema } from "@commonfabric/api";
import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  type LLMNativeModelToolId,
} from "@commonfabric/llm/types";
import type { HarnessFailureRecord } from "../diagnostics.ts";
import type {
  HarnessModelAuthSource,
  HarnessModelProviderId,
} from "../config.ts";
import type { HarnessCredentialOwnerRef } from "./run-manifest.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillScriptExecutionTarget,
} from "./skill.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";

export const DEFAULT_SUBAGENT_PROFILE = "default" as const;
export const BROWSER_SUBAGENT_PROFILE = "browser" as const;
export const WEB_FETCH_SUBAGENT_PROFILE = "web_fetch" as const;
export const WEB_SEARCH_SUBAGENT_PROFILE = "web_search" as const;
export const PATTERN_AUTHOR_SUBAGENT_PROFILE = "pattern-author" as const;
export const WEB_SEARCH_SUBAGENT_MODEL = "gemini-3.5-flash" as const;
export const DEFAULT_SUBAGENT_MAX_MODEL_TURNS = 8;
export const MAX_SUBAGENT_MAX_MODEL_TURNS = 64;
export const DEFAULT_SUBAGENT_RETURN_CHANNEL =
  "summary-and-sanitized-state" as const;
/**
 * Tool surface of the `default` profile. `run_pattern` is gated the same way
 * the parent surface gates it: the prompt loop drops it from a child whose
 * engine has no fabric session, so the tool is absent rather than
 * present-but-failing.
 */
export const DEFAULT_SUBAGENT_ALLOWED_TOOL_IDS = [
  "bash",
  "read_file",
  "view_image",
  "edit_file",
  "write_file",
  "run_pattern",
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
/**
 * Tool surface of the `pattern-author` profile. The child writes pattern source
 * into `run_pattern` arguments rather than into the workspace, so it receives
 * neither `write_file` nor `edit_file`: its deliverable is a result reference,
 * not a file. `bash` and `read_file` are there to read existing patterns and
 * documentation. `run_pattern` is gated on a configured fabric session exactly
 * as it is for the `default` profile.
 */
export const PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS = [
  "bash",
  "read_file",
  "read_skill_resource",
  "run_pattern",
] as const satisfies readonly BuiltinToolId[];
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
/**
 * Skills preloaded into a `pattern-author` child when the run has a skill
 * registry. These are the documents a pattern author would otherwise spend its
 * whole turn budget rediscovering: the authoring guide and the schema-design
 * guide. Preload is best-effort — a run whose skills root does not carry them
 * gets a child with the same tools and no preloaded guidance.
 */
export const PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES = [
  "pattern-dev",
  "pattern-schema",
] as const satisfies readonly string[];
export const WEB_SEARCH_SUBAGENT_NATIVE_MODEL_TOOL_IDS = [
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
] as const satisfies readonly HarnessNativeModelToolId[];

export const HARNESS_SUBAGENT_PROFILES = [
  DEFAULT_SUBAGENT_PROFILE,
  BROWSER_SUBAGENT_PROFILE,
  WEB_FETCH_SUBAGENT_PROFILE,
  WEB_SEARCH_SUBAGENT_PROFILE,
  PATTERN_AUTHOR_SUBAGENT_PROFILE,
] as const;

export type HarnessSubagentProfile = typeof HARNESS_SUBAGENT_PROFILES[number];
export type HarnessSubagentModelSource = "parent" | "profile";
export type HarnessNativeModelToolId = LLMNativeModelToolId;
export type HarnessSubagentRunStatus = "completed" | "failed";
export type HarnessSubagentReturnChannel =
  typeof DEFAULT_SUBAGENT_RETURN_CHANNEL;

export interface HarnessSubagentLineage {
  role: "subagent";
  rootRunId: string;
  parentRunId: string;
  parentToolCallId: string;
  depth: number;
}

export interface HarnessSubagentResumeContext {
  type: "cf-harness.subagent-resume-context";
  version: 1;
  rootRunId: string;
  parentRunId: string;
  parentToolCallId: string;
}

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

export const PATTERN_AUTHOR_SUBAGENT_PROFILE_CONFIG:
  HarnessSubagentProfileConfig = {
    type: "cf-harness.subagent-profile-config",
    profile: PATTERN_AUTHOR_SUBAGENT_PROFILE,
    allowedToolIds: PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS,
    hostToolIds: NO_HOST_TOOL_IDS,
    skillNames: PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES,
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
    case PATTERN_AUTHOR_SUBAGENT_PROFILE:
      return PATTERN_AUTHOR_SUBAGENT_PROFILE_CONFIG;
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
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwner?: HarnessCredentialOwnerRef;
  harnessHomeIdentity?: string;
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

interface HarnessSubagentRunRefBase {
  type: "cf-harness.subagent-run-ref";
  parentToolCallId: string;
  childRunId: string;
  manifest: HarnessSubagentRunManifest;
}

export interface HarnessRunningSubagentRunRef
  extends HarnessSubagentRunRefBase {
  status: "running";
  outputId?: never;
  summary?: never;
  runState?: never;
  structuredReturn?: never;
}

export interface HarnessTerminalSubagentRunRef
  extends HarnessSubagentRunRefBase {
  status: HarnessSubagentRunStatus;
  outputId?: string;
  summary: string;
  runState: HarnessSubagentRunStateSummary;
  structuredReturn?: HarnessSubagentStructuredReturn;
}

export type HarnessSubagentRunRef =
  | HarnessRunningSubagentRunRef
  | HarnessTerminalSubagentRunRef;

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
