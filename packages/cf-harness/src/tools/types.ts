import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { ToolOutputId } from "../contracts/tool-result.ts";
import type { ProcessRunner } from "../sandbox/process-runner.ts";
import type { SandboxRuntime } from "../sandbox/types.ts";

export interface HarnessToolContext {
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  sandbox: SandboxRuntime;
  hostProcessRunner: ProcessRunner;
  currentDir: string;
  resolvePath(path: string): string;
  resolveHostPath(path: string): string;
  hostPathToWorkspacePath(path: string): string | undefined;
  isHostPathWithinWorkspace(path: string): Promise<boolean>;
  setCurrentDir(path: string): void;
  nextOutputId(toolId: string): ToolOutputId;
}

export interface HarnessToolDefinition<Input = unknown, Output = unknown> {
  descriptor: HarnessToolDescriptor;
  invoke(context: HarnessToolContext, input: Input): Promise<Output>;
}

export const createUnimplementedToolError = (toolId: string): Error =>
  new Error(`${toolId} is not implemented yet`);
