import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { ObservationDenied } from "./observation.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessSubagentProfile } from "./subagent.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";

export type HarnessPolicyEventSeverity = "warning" | "denied";

export interface HarnessBashToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "bash";
  cwd?: string;
  timeoutMs?: number;
  commandBytes?: number;
  commandDigest?: string;
}

export interface HarnessReadFileToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "read_file";
  path?: string;
  maxBytes?: number;
}

export interface HarnessReadSkillResourceToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "read_skill_resource";
  skill?: string;
  path?: string;
  maxBytes?: number;
}

export interface HarnessWebFetchToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "web_fetch";
  url?: string;
  maxBytes?: number;
  maxTextChars?: number;
  timeoutMs?: number;
}

export interface HarnessWriteFileToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "write_file";
  path?: string;
  mode?: "replace" | "append";
  createParents?: boolean;
  contentBytes?: number;
  contentDigest?: string;
}

export interface HarnessEditFileToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "edit_file";
  path?: string;
  editCount?: number;
  expectedDigest?: string;
  oldTextBytes?: number;
  oldTextDigest?: string;
  newTextBytes?: number;
  newTextDigest?: string;
}

export interface HarnessDelegateTaskToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "delegate_task";
  profile?: HarnessSubagentProfile;
  goalBytes?: number;
  goalDigest?: string;
  contextBytes?: number;
  contextDigest?: string;
  returnSchemaBytes?: number;
  returnSchemaDigest?: string;
  maxModelTurns?: number;
}

export type HarnessToolInputSummary =
  | HarnessBashToolInputSummary
  | HarnessReadFileToolInputSummary
  | HarnessReadSkillResourceToolInputSummary
  | HarnessWebFetchToolInputSummary
  | HarnessEditFileToolInputSummary
  | HarnessWriteFileToolInputSummary
  | HarnessDelegateTaskToolInputSummary
  | {
    type: "cf-harness.tool-input-summary";
    toolId: BuiltinToolId;
  };

export interface HarnessPolicyEvent {
  type: "cf-harness.policy-event";
  severity: HarnessPolicyEventSeverity;
  mode: CfcEnforcementMode;
  toolId: string;
  detail: string;
  at: string;
  toolCallId?: string;
  promptSlot?: PromptSlotBinding;
  toolInputSummary?: HarnessToolInputSummary;
  observationDenied?: ObservationDenied;
}

export const createHarnessPolicyEvent = (
  input: Omit<HarnessPolicyEvent, "type">,
): HarnessPolicyEvent => ({
  type: "cf-harness.policy-event",
  ...input,
});
