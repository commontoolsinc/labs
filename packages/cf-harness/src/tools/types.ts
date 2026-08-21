import type {
  CfcEnforcementMode,
  CfcLabelView,
} from "@commonfabric/runner/cfc";
import type {
  HarnessCfcInvocationContext,
  HarnessCfcInvocationInputLabelPath,
  HarnessCfcInvocationOperation,
} from "../contracts/cfc-invocation-context.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
  HarnessSkillScriptExecution,
  HarnessSkillScriptExecutionTarget,
} from "../contracts/skill.ts";
import type { HarnessBrowserAccessLease } from "../contracts/browser-access.ts";
import type { HarnessHandleTable } from "../contracts/handle-table.ts";
import type { HarnessResolvedValueRegister } from "../contracts/resolved-value-register.ts";
import type { HarnessFabricSession } from "../fabric-session.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { ToolOutputId } from "../contracts/tool-result.ts";
import type { ProcessRunner } from "../sandbox/process-runner.ts";
import type { SandboxRuntime } from "../sandbox/types.ts";

export interface HarnessToolContext {
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  skillRegistry?: HarnessSkillRegistry;
  skillActivations?: HarnessSkillActivations;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;
  /**
   * Origins a value materialized from a handle may be sent to. Absent or
   * empty means none: materialization is default-deny by destination, and a
   * tool that would send a handle's value somewhere refuses rather than
   * asking the model where it meant.
   */
  handleValueOrigins?: readonly string[];
  /**
   * The run's handle table, as it stands at the invocation. Undefined until
   * the run mints its first handle. `describe_handle` is the only tool that
   * reads it: every other tool sees its input with tokens already resolved to
   * addresses by the prompt loop.
   */
  handleTable?: HarnessHandleTable;
  /**
   * The run's register of values materialized from handles, and the scrub
   * that keeps them out of model-facing output for the rest of the run. The
   * engine always supplies one; a tool that materializes a value without it
   * can only scrub within its own invocation, which leaves a later read of
   * the same page unguarded.
   */
  resolvedValueRegister?: HarnessResolvedValueRegister;
  /**
   * The run's trusted Fabric session, lazy and cached by the engine.
   * Undefined when the run has no fabric session configured, which also
   * keeps `run_pattern` out of the tool surface.
   */
  getFabricSession?: () => Promise<HarnessFabricSession>;
  /**
   * The prompt loop's run-level abort signal, when the invocation came
   * through the loop. The only cancellation source a tool may honor — no
   * tool-side timeout supplements it. Tools are free to ignore it.
   */
  signal?: AbortSignal;
  sandbox: SandboxRuntime;
  hostProcessRunner: ProcessRunner;
  currentDir: string;
  workspaceHostPath?: string;
  resolvePath(path: string): string;
  resolveHostPath(path: string): string;
  resolveHostRootPath(path: string): string;
  hostPathToWorkspacePath(path: string): string | undefined;
  isHostPathWithinWorkspace(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  isHostPathWithinArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  /**
   * Host directory for image-attachment snapshots (under the artifact
   * root). Undefined when the run has no artifact store; attachments then
   * stay locked to their source file's bytes.
   */
  imageAttachmentSnapshotDir?: string;
  doesHostPathIntersectArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  setCurrentDir(path: string): void;
  nextOutputId(toolId: string): ToolOutputId;
  now(): string;
  recordSkillResourceRead(read: HarnessSkillResourceRead): Promise<void>;
  recordSkillScriptExecution(
    execution: HarnessSkillScriptExecution,
  ): Promise<void>;
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
    cfcInputLabelPaths?: readonly HarnessCfcInvocationInputLabelPath[];
    cfcPromptSlotInputLabelPaths?:
      readonly HarnessCfcInvocationInputLabelPath[];
    cfcModelContextInputLabelPaths?:
      readonly HarnessCfcInvocationInputLabelPath[];
  }): Promise<HarnessCfcInvocationContext>;
}

export interface HarnessToolDefinition<Input = unknown, Output = unknown> {
  descriptor: HarnessToolDescriptor;
  invoke(context: HarnessToolContext, input: Input): Promise<Output>;
}

export const createUnimplementedToolError = (toolId: string): Error =>
  new Error(`${toolId} is not implemented yet`);
