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
export const EXPLORE_SUBAGENT_PROFILE = "explore" as const;
export const WEB_SEARCH_SUBAGENT_MODEL = "gemini-3.5-flash" as const;

/**
 * The model an explore turn runs on. A profile's `modelOverride` reaches the
 * provider verbatim as the request's `model`, so this is the gateway's own
 * name for the model and carries no routing prefix.
 */
export const EXPLORE_SUBAGENT_MODEL = "gemini-3.5-flash" as const;
export const DEFAULT_SUBAGENT_MAX_MODEL_TURNS = 8;
export const MAX_SUBAGENT_MAX_MODEL_TURNS = 64;
export const MAX_DELEGATE_PATTERN_REFS = 8;
export const MAX_DELEGATE_PATTERN_REF_NOTE_LENGTH = 500;

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
  "browser",
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
 * the `default` profile, and `search_patterns` and `record_feedback` on a
 * configured pattern index: an author that can find an existing pattern for
 * the job should compose it rather than write one, and say how the one it ran
 * turned out.
 *
 * `query_docs` is how an author reaches documentation it has no path to. A
 * child cannot delegate — this profile has no `delegate_task`, and the
 * subagent manifest pins the depth at one — so an explore agent is a tool on
 * this surface or it is unreachable from the one context that needs it.
 */
export const PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS = [
  "bash",
  "read_file",
  "read_skill_resource",
  "describe_handle",
  "run_pattern",
  "search_patterns",
  "record_feedback",
  "query_docs",
] as const satisfies readonly BuiltinToolId[];

/**
 * Tool surface of the `explore` profile: none at all. The child is handed the
 * documentation sections it may answer out of and has no way to reach anything
 * else — no file it could read, no command it could run, no space it could
 * touch. Read-only is the profile's shape rather than a rule applied to it.
 */
export const EXPLORE_SUBAGENT_ALLOWED_TOOL_IDS =
  [] as const satisfies readonly BuiltinToolId[];

export const NO_HOST_TOOL_IDS = [] as const satisfies readonly BuiltinToolId[];
export const BROWSER_SUBAGENT_HOST_TOOL_IDS = [
  "browser",
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
 * whole turn budget rediscovering: the authoring guide, the schema-design
 * guide, and the UI guide. The UI guide carries the cf- component and
 * two-way-binding idiom; without it an author reaches for raw HTML inputs
 * and DOM-event handlers, which compile and render but never fire.
 * Preload is best-effort — a run whose skills root does not carry them
 * gets a child with the same tools and no preloaded guidance.
 */
export const PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES = [
  "pattern-dev",
  "pattern-schema",
  "pattern-ui",
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
 * Who declares a delegation's return contract. `caller` lets a `returnSchema`
 * the caller wrote replace the profile's, which is the ordinary case: the
 * profile's contract is the shape a delegation that declares none falls back
 * to. `profile` does not — the profile's contract IS the delegation's, and a
 * caller that declares one is refused with the reason.
 *
 * A profile whose whole purpose is a narrow return channel keeps authority
 * over it. A caller-written schema can widen that channel to any shape at
 * all, including one that carries a value the profile's own contract admits
 * no field for; the channel is only as narrow as the widest schema anyone may
 * declare against it.
 */
export type HarnessSubagentReturnContractAuthority = "caller" | "profile";

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
 * The success branch is a RUNNING pattern's result cell and nothing else: a
 * reference, a line of prose about what it computes, and the hashtags it was
 * recorded in the index under. There is no field for source, in any
 * encoding, because a parent has no use for source it should not be
 * compiling — the child ran the pattern, and reuse travels through the index,
 * where a searcher finds an atom by its hashtags and composes it by its
 * import specifier without the source passing through anyone's context.
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
        hashtags: {
          type: "array",
          items: { type: "string" },
          description:
            "The hashtags the pattern was recorded in the index under: the words a later search finds it by if evidence earns discoverability. Omitted by a run with no pattern index, which publishes nothing.",
        },
      },
      required: ["ok", "resultRef", "describes"],
      additionalProperties: false,
    },
    SUBAGENT_FAILURE_RETURN_SCHEMA,
  ],
};

/** Longest answer the `explore` profile may return, in characters. */
export const MAX_EXPLORE_ANSWER_LENGTH = 2_000;

/** Most citations one explore answer may name. */
export const MAX_EXPLORE_CITATIONS = 8;

/**
 * Return contract of the `explore` profile: a bounded answer and the places it
 * came from, and nothing else.
 *
 * The bound on `answer` is what keeps the asking child's context intact — the
 * point of asking a question rather than reading a file is that the reply is
 * the size of an answer. The citations are inert: a path and a heading address
 * a place in the corpus, carrying no text and no handle, so reading that place
 * stays a separate act by whoever is entitled to it.
 */
export const EXPLORE_RETURN_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      maxLength: MAX_EXPLORE_ANSWER_LENGTH,
      description:
        "The answer to the question, drawn only from the supplied sections.",
    },
    citations: {
      type: "array",
      maxItems: MAX_EXPLORE_CITATIONS,
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Corpus path of a supplied section, exactly as given.",
          },
          heading: {
            type: "string",
            description: "Heading of that section, exactly as given.",
          },
        },
        required: ["path", "heading"],
        additionalProperties: false,
      },
      description: "The sections the answer was drawn from.",
    },
  },
  required: ["answer", "citations"],
  additionalProperties: false,
};

export const WEB_SEARCH_SUBAGENT_NATIVE_MODEL_TOOL_IDS = [
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
] as const satisfies readonly HarnessNativeModelToolId[];

/** The profiles a `delegate_task` call may name. */
export const HARNESS_SUBAGENT_PROFILES = [
  DEFAULT_SUBAGENT_PROFILE,
  BROWSER_SUBAGENT_PROFILE,
  WEB_FETCH_SUBAGENT_PROFILE,
  WEB_SEARCH_SUBAGENT_PROFILE,
  PATTERN_AUTHOR_SUBAGENT_PROFILE,
] as const;

/**
 * The profiles the harness runs on a caller's behalf rather than on a
 * delegation's. `explore` is one because its answer is only as good as the
 * corpus it was handed, and the harness is what hands it one: a delegation
 * naming it directly would put a model with no documentation in front of a
 * schema that asks for citations, which is the failure this profile exists to
 * end rather than to reproduce.
 */
export const HARNESS_INTERNAL_SUBAGENT_PROFILES = [
  EXPLORE_SUBAGENT_PROFILE,
] as const;

export type HarnessDelegableSubagentProfile =
  typeof HARNESS_SUBAGENT_PROFILES[number];
export type HarnessSubagentProfile =
  | HarnessDelegableSubagentProfile
  | typeof HARNESS_INTERNAL_SUBAGENT_PROFILES[number];
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
   * Return contract of a delegation to this profile. A profile that owns one
   * leaves no delegation unstructured: the return is a shape the parent can
   * test rather than an open-ended summary a failure and a success both
   * satisfy.
   */
  returnSchema?: JSONSchema;

  /**
   * Whether a caller may replace {@link returnSchema} with one of its own.
   * Absent reads as `caller`, the ordinary case; a profile that means to hold
   * its channel says `profile`.
   */
  returnContractAuthority?: HarnessSubagentReturnContractAuthority;

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
    returnSchema: PATTERN_AUTHOR_RETURN_SCHEMA,
    returnContractAuthority: "profile",
    returnPolicy: DEFAULT_SUBAGENT_RETURN_POLICY,
  };

/**
 * The `explore` profile: a cheap model, no tools, one turn, and a return
 * contract it does not share authority over. Every property is the same
 * decision — the child answers one question out of the text it was handed, and
 * a single turn is all that takes.
 */
export const EXPLORE_SUBAGENT_PROFILE_CONFIG: HarnessSubagentProfileConfig = {
  type: "cf-harness.subagent-profile-config",
  profile: EXPLORE_SUBAGENT_PROFILE,
  allowedToolIds: EXPLORE_SUBAGENT_ALLOWED_TOOL_IDS,
  hostToolIds: NO_HOST_TOOL_IDS,
  modelOverride: EXPLORE_SUBAGENT_MODEL,
  maxModelTurns: 1,
  returnSchema: EXPLORE_RETURN_SCHEMA,
  returnContractAuthority: "profile",
  returnPolicy: DEFAULT_SUBAGENT_RETURN_POLICY,
};

export const isHarnessSubagentProfile = (
  input: string,
): input is HarnessDelegableSubagentProfile =>
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
    case EXPLORE_SUBAGENT_PROFILE:
      return EXPLORE_SUBAGENT_PROFILE_CONFIG;
  }
};

/**
 * Whether a delegation to `profile` may declare a `returnSchema` of its own.
 * A profile with no contract of its own has nothing to protect, so a caller
 * schema is the only structure such a delegation can have.
 */
export const subagentProfileAcceptsCallerReturnSchema = (
  profile: HarnessSubagentProfile,
): boolean => {
  const config = getHarnessSubagentProfileConfig(profile);
  return config.returnSchema === undefined ||
    config.returnContractAuthority !== "profile";
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

  /**
   * The skill-context handle token this delegation carried, when it carried
   * one. Absent means the child ran with no acquired skill, which is a fact
   * about the run and not a gap in the record.
   *
   * The run's outstanding skill custody is read off this field and {@link
   * HarnessTerminalSubagentRunRef.status}: a token whose most recent
   * delegation did not complete has custody outstanding, and the next
   * delegation must either carry that token again or say it is deliberately
   * running without it. Deriving custody from the run state rather than from
   * memory is what makes it survive a resume.
   */
  skillHandle?: string;

  /**
   * Set when this delegation stated it deliberately carries no acquired
   * skill. It discharges the run's outstanding custody: the parent has
   * answered the question the refusal asks, once, and later delegations are
   * not asked again. Recording it here rather than in memory is what makes
   * the answer survive a resume, and what lets a reader see that a
   * skill-free child was chosen rather than a field dropped.
   */
  withoutSkillHandle?: boolean;
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

/** One published pattern the parent selected from its prior search results. */
export interface DelegateTaskPatternRef {
  /** Content-addressed id exactly as `search_patterns` returned it. */
  patternId: string;

  /** Parent-authored context for this selection, passed to the child verbatim. */
  note?: string;
}

/** An inert refusal for a selected id absent from the parent's search record. */
export interface DelegateTaskPatternRefRefusal {
  patternId: string;
  reason: "not-searched-by-parent";
}

export interface DelegateTaskToolInput {
  goal: string;
  profile: HarnessSubagentProfile;
  context?: string;
  maxModelTurns?: number;
  returnSchema?: JSONSchema;

  /** Published patterns selected from this parent's prior search results. */
  patternRefs?: readonly DelegateTaskPatternRef[];

  /**
   * A handle the PARENT holds, naming a cell whose string value is skill
   * text for the child. Materialized trusted-side at child spawn — the
   * parent never reads the text, and the child receives it as a skill
   * context block rather than as a registry activation, so selection is by
   * unforgeable table membership instead of by name.
   */
  skillHandle?: string;

  /**
   * States that this delegation deliberately carries no acquired skill. It is
   * required — and meaningful — only while the run has outstanding skill
   * custody: a delegation that carried a handle did not complete, and the
   * next one omitting {@link DelegateTaskToolInput.skillHandle} would
   * otherwise silently produce work nothing records as skill-free.
   *
   * It grants nothing and attaches nothing. Its whole effect is to make the
   * choice explicit in the transcript and the run state, so a reader can tell
   * a considered decision from a dropped field. Stating it once discharges
   * the custody it answers: a run does not carry the flag for the rest of its
   * life because one child died.
   */
  withoutSkillHandle?: boolean;
}

export interface DelegateTaskToolOutput {
  type: "cf-harness.delegate-task-output";
  outputId: string;
  subagent: HarnessSubagentResult;
  patternRefRefusals?: readonly DelegateTaskPatternRefRefusal[];
}
