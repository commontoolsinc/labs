import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { ToolOutputId } from "./tool-result.ts";

export type HarnessAuditEventKind =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "tool.invoked"
  | "tool.completed"
  | "tool.failed"
  | "observation.denied";

export interface HarnessAuditEvent {
  eventId: string;
  runId: string;
  timestamp: string;
  kind: HarnessAuditEventKind;
  cfcEnforcementMode?: CfcEnforcementMode;
  toolId?: string;
  outputId?: ToolOutputId;
  data?: Record<string, unknown>;
}

export const createHarnessAuditEvent = (
  runId: string,
  kind: HarnessAuditEventKind,
  options: Partial<
    Omit<HarnessAuditEvent, "eventId" | "runId" | "timestamp" | "kind">
  > = {},
): HarnessAuditEvent => ({
  eventId: crypto.randomUUID(),
  runId,
  timestamp: new Date().toISOString(),
  kind,
  ...(options.cfcEnforcementMode !== undefined
    ? { cfcEnforcementMode: options.cfcEnforcementMode }
    : {}),
  ...(options.toolId !== undefined ? { toolId: options.toolId } : {}),
  ...(options.outputId !== undefined ? { outputId: options.outputId } : {}),
  ...(options.data !== undefined ? { data: options.data } : {}),
});
