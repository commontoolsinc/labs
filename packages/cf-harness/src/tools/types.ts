import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { ToolOutputId } from "../contracts/tool-result.ts";

export interface HarnessToolContext {
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  nextOutputId(toolId: string): ToolOutputId;
}

export interface HarnessToolDefinition<Input = unknown, Output = unknown> {
  descriptor: HarnessToolDescriptor;
  invoke(context: HarnessToolContext, input: Input): Promise<Output>;
}

export const createUnimplementedToolError = (toolId: string): Error =>
  new Error(`${toolId} is not implemented yet`);
