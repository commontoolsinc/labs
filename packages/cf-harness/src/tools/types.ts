import type {
  CfcEnforcementMode,
  CfcLabelView,
} from "@commonfabric/runner/cfc";
import type {
  HarnessCfcInvocationContext,
  HarnessCfcInvocationOperation,
} from "../contracts/cfc-invocation-context.ts";
import type {
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
} from "../contracts/skill.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { ToolOutputId } from "../contracts/tool-result.ts";
import type { ProcessRunner } from "../sandbox/process-runner.ts";
import type { SandboxRuntime } from "../sandbox/types.ts";

export interface HarnessToolContext {
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  skillRegistry?: HarnessSkillRegistry;
  sandbox: SandboxRuntime;
  hostProcessRunner: ProcessRunner;
  currentDir: string;
  workspaceHostPath?: string;
  resolvePath(path: string): string;
  resolveHostPath(path: string): string;
  hostPathToWorkspacePath(path: string): string | undefined;
  isHostPathWithinWorkspace(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  isHostPathWithinArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  doesHostPathIntersectArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  setCurrentDir(path: string): void;
  nextOutputId(toolId: string): ToolOutputId;
  now(): string;
  recordSkillResourceRead(read: HarnessSkillResourceRead): Promise<void>;
  createCfcInvocationContext(options: {
    toolId: string;
    toolOutputId?: ToolOutputId;
    operation: HarnessCfcInvocationOperation;
    cwd: string;
    command?: string;
    argv?: readonly string[];
    args?: readonly string[];
    stdinText?: string;
    env?: Record<string, string>;
    cfcInputLabels?: CfcLabelView;
  }): Promise<HarnessCfcInvocationContext>;
}

export interface HarnessToolDefinition<Input = unknown, Output = unknown> {
  descriptor: HarnessToolDescriptor;
  invoke(context: HarnessToolContext, input: Input): Promise<Output>;
}

export const createUnimplementedToolError = (toolId: string): Error =>
  new Error(`${toolId} is not implemented yet`);
