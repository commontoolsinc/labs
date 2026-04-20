import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { ObservationDenied } from "./observation.ts";

export type HarnessPolicyEventSeverity = "warning" | "denied";

export interface HarnessPolicyEvent {
  type: "cf-harness.policy-event";
  severity: HarnessPolicyEventSeverity;
  mode: CfcEnforcementMode;
  toolId: string;
  detail: string;
  at: string;
  toolCallId?: string;
  observationDenied?: ObservationDenied;
}

export const createHarnessPolicyEvent = (
  input: Omit<HarnessPolicyEvent, "type">,
): HarnessPolicyEvent => ({
  type: "cf-harness.policy-event",
  ...input,
});
