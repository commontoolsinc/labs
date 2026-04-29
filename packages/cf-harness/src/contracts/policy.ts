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

export interface HarnessWriteFileToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "write_file";
  path?: string;
  mode?: "replace" | "append";
  createParents?: boolean;
  contentBytes?: number;
  contentDigest?: string;
}

export interface HarnessDelegateTaskToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "delegate_task";
  profile?: HarnessSubagentProfile;
  goalBytes?: number;
  goalDigest?: string;
  contextBytes?: number;
  contextDigest?: string;
  maxModelTurns?: number;
}

export type HarnessToolInputSummary =
  | HarnessBashToolInputSummary
  | HarnessReadFileToolInputSummary
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
