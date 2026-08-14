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
/**
 * Turn budget of the `pattern-author` profile. Authoring is a write,
 * compile-error, fix loop, and each iteration costs a turn; at the default
 * budget the loop runs out before a non-trivial pattern compiles, and a child
 * that ran out of turns has nothing to return. The budget is the profile's
 * own rather than the run's, so raising it does not loosen any other child.
 */
export const PATTERN_AUTHOR_SUBAGENT_MAX_MODEL_TURNS = 24;
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
 * documentation. `describe_handle` gives it the shape of a reference it was
 * handed, which is what it authors against — it cannot read the value.
 * `run_pattern` is gated on a configured fabric session exactly as it is for
 * the `default` profile.
 */
export const PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS = [
  "bash",
  "read_file",
  "read_skill_resource",
  "describe_handle",
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
/**
 * The vocabulary a child reports a failure in. A code is inert by
 * construction — it is one of a fixed set, carries nothing read out of a
 * space, and survives sanitization as itself — so a parent learns WHY a
 * delegation failed without any declassification.
 *
 * - `compile-error`: the write/compile/fix loop did not converge.
 * - `turn-budget-exhausted`: the turn budget ran out mid-task.
 * - `schema-mismatch`: the result could not be made to fit the shape asked
 *   for.
 * - `missing-input-shape`: an input reference's shape was not available or
 *   not what the task described.
 * - `unsupported-request`: the task cannot be done with this profile's tools
 *   or within its policy.
 * - `other`: none of the above.
 */
export const SUBAGENT_FAILURE_REASON_CODES = [
  "compile-error",
  "turn-budget-exhausted",
  "schema-mismatch",
  "missing-input-shape",
  "unsupported-request",
  "other",
] as const;

export type HarnessSubagentFailureReasonCode =
  typeof SUBAGENT_FAILURE_REASON_CODES[number];

export const isHarnessSubagentFailureReasonCode = (
  input: unknown,
): input is HarnessSubagentFailureReasonCode =>
  typeof input === "string" &&
  (SUBAGENT_FAILURE_REASON_CODES as readonly string[]).includes(input);

/**
 * The failure branch every profile contract shares: `ok: false` plus a code
 * from the fixed vocabulary, and an optional free-text `detail`. `detail`
 * seals into an opaque link like any unconstrained string, which is the right
 * treatment — the code is the actionable part, and the parent can open the
 * detail only if it is entitled to.
 */
export const SUBAGENT_FAILURE_RETURN_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: false },
    code: {
      type: "string",
      enum: [...SUBAGENT_FAILURE_REASON_CODES],
      description: "Why the task could not be completed.",
    },
    detail: {
      type: "string",
      description:
        "Optional free-text elaboration. Reaches the parent as an opaque link, so it is for a reader entitled to open it, not for the parent to act on.",
    },
  },
  required: ["ok", "code"],
  additionalProperties: false,
};

/**
 * Reads a child's parsed return as a failure report. `ok: false` is the
 * discriminator across every contract, declared or profile-default, so a child
 * that says it failed is heard as having failed whatever else about its return
 * is malformed. An unrecognized or absent code reads as `other`: the report
 * still stands, only less specifically.
 */
export const asHarnessSubagentFailureReport = (
  value: unknown,
): { code: HarnessSubagentFailureReasonCode } | undefined => {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as Record<string, unknown>).ok !== false
  ) {
    return undefined;
  }
  const code = (value as Record<string, unknown>).code;
  return {
    code: isHarnessSubagentFailureReasonCode(code) ? code : "other",
  };
};

/**
 * Return contract of the `pattern-author` profile: a discriminated union, so
 * a success and a failure are different SHAPES rather than different prose.
 * A parent reading `ok` knows which it has without interpreting text, and a
 * `resultRef` exists only on the branch that produced one — which is what
 * stops a failed child's delegation from being answered with some other
 * step's reference.
 *
 * Failure is a first-class branch, not an error path: a child that cannot
 * produce a working pattern returns the shared failure shape, whose `code`
 * names what stopped it from the fixed inert vocabulary — no data read out of
 * the space, no partial result dressed as a whole one.
 *
 * The free-form strings arrive at the parent as opaque links, the ordinary
 * treatment of unconstrained strings in a sanitized child return; `ok`, the
 * failure `code`, and the minted `resultRef` token are what the parent acts
 * on.
 */
export const PATTERN_AUTHOR_RETURN_SCHEMA: JSONSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        ok: { type: "boolean", const: true },
        resultRef: {
          type: "string",
          description:
            "The reference run_pattern returned for the working pattern's result cell.",
        },
        describes: {
          type: "string",
          description:
            "One or two inert sentences saying what the pattern computes. No data read out of the space.",
        },
      },
      required: ["ok", "resultRef", "describes"],
      additionalProperties: false,
    },
    SUBAGENT_FAILURE_RETURN_SCHEMA,
  ],
};

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
  /**
   * Return contract applied to a delegation to this profile that declares no
   * `returnSchema` of its own. A profile that owns one leaves no delegation
   * unstructured: the caller either declares the shape it wants or gets the
   * profile's, never an open-ended summary a failure and a success can both
   * satisfy.
   */
  defaultReturnSchema?: JSONSchema;
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
    maxModelTurns: PATTERN_AUTHOR_SUBAGENT_MAX_MODEL_TURNS,
    defaultReturnSchema: PATTERN_AUTHOR_RETURN_SCHEMA,
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

/**
 * The parent-facing view of a child's failure. Every field is harness
 * vocabulary: a `kind` and `source` from a closed set, an output id the
 * harness minted, an exit code, and a `toolId` that is either a tool the run
 * offers or a fixed sentinel. The identifiers a child chose — the tool name a
 * model wrote, its call id, a command name parsed out of shell output — stay
 * in the audit artifacts, where no model reads them.
 */
export interface HarnessSubagentFailureSummary extends
  Pick<
    HarnessFailureRecord,
    "kind" | "source" | "toolId" | "outputId" | "exitCode"
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
  /**
   * `child-reported-failure` is its own status because a child saying it
   * failed is an answer, not a broken return: the parent gets a failure it can
   * act on — the `failureCode` — instead of a schema complaint that says only
   * that something went wrong somewhere.
   */
  status: "valid" | "invalid" | "child-reported-failure";
  /**
   * Present whenever the child's return says `ok: false`, on either status.
   */
  failureCode?: HarnessSubagentFailureReasonCode;
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
