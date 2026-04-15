import {
  type HarnessConfig,
  resolveHarnessConfig,
  type ResolveHarnessConfigOptions,
} from "./config.ts";
import {
  appendHarnessToolOutput,
  createHarnessRunState,
  type HarnessRunState,
  setHarnessRunStatus,
} from "./run-state.ts";
import {
  createToolResultRef,
  type ToolOutputId,
  type ToolResultRef,
} from "./contracts/tool-result.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import {
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "./sandbox/docker-runsc.ts";
import type { ProcessRunner } from "./sandbox/process-runner.ts";
import type { HarnessSandboxConfig, SandboxRuntime } from "./sandbox/types.ts";
import {
  bashTool,
  type BashToolInput,
  type BashToolOutput,
} from "./tools/bash.ts";
import {
  readFileTool,
  type ReadFileToolInput,
  type ReadFileToolOutput,
} from "./tools/read-file.ts";
import {
  writeFileTool,
  type WriteFileToolInput,
  type WriteFileToolOutput,
} from "./tools/write-file.ts";
import { getBuiltinTool } from "./tools/registry.ts";

export interface BuiltinToolInputMap {
  bash: BashToolInput;
  read_file: ReadFileToolInput;
  write_file: WriteFileToolInput;
}

export interface BuiltinToolOutputMap {
  bash: BashToolOutput;
  read_file: ReadFileToolOutput;
  write_file: WriteFileToolOutput;
}

interface ToolOutputWithId {
  outputId: string;
}

export interface CreateHarnessEngineOptions
  extends ResolveHarnessConfigOptions {
  runId?: string;
  runState?: HarnessRunState;
  workspaceHostPath?: string;
  sandboxRuntime?: SandboxRuntime;
  processRunner?: ProcessRunner;
  now?: () => string;
}

export interface BuiltinToolInvocationResult<
  TToolId extends BuiltinToolId,
> {
  output: BuiltinToolOutputMap[TToolId];
  resultRef: ToolResultRef;
  runState: HarnessRunState;
}

const isToolOutputWithId = (value: unknown): value is ToolOutputWithId =>
  typeof value === "object" &&
  value !== null &&
  "outputId" in value &&
  typeof value.outputId === "string";

const resolveSandboxConfig = (
  config: HarnessConfig,
  workspaceHostPath?: string,
): HarnessSandboxConfig => {
  if (config.sandbox !== undefined) {
    return config.sandbox;
  }
  if (workspaceHostPath === undefined) {
    throw new Error(
      "sandbox config is required when no workspaceHostPath default is provided",
    );
  }
  return resolveDockerRunscSandboxConfig({ workspaceHostPath });
};

const createSandboxRuntime = (
  config: HarnessSandboxConfig,
  processRunner?: ProcessRunner,
): SandboxRuntime => {
  switch (config.kind) {
    case "docker-runsc-cfc":
      return new DockerRunscSandboxRuntime(config, processRunner);
  }
};

export class CfHarnessEngine {
  readonly config: HarnessConfig;
  readonly sandbox: SandboxRuntime;

  #runState: HarnessRunState;
  #outputSequence: number;
  readonly #now: () => string;

  constructor(options: CreateHarnessEngineOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.config = resolveHarnessConfig(options);
    this.sandbox = options.sandboxRuntime ??
      createSandboxRuntime(
        resolveSandboxConfig(this.config, options.workspaceHostPath),
        options.processRunner,
      );
    this.#runState = options.runState ??
      createHarnessRunState({
        runId: options.runId,
        cfcEnforcementMode: this.config.cfcEnforcementMode,
        now: this.#now(),
      });
    this.#outputSequence = this.#runState.toolOutputs.length;
  }

  getRunState(): HarnessRunState {
    return {
      ...this.#runState,
      toolOutputs: [...this.#runState.toolOutputs],
    };
  }

  async invokeBuiltinTool<TToolId extends BuiltinToolId>(
    toolId: TToolId,
    input: BuiltinToolInputMap[TToolId],
  ): Promise<BuiltinToolInvocationResult<TToolId>> {
    const tool = getBuiltinTool(toolId);
    if (tool === undefined) {
      throw new Error(`unknown builtin tool: ${toolId}`);
    }
    this.#runState = setHarnessRunStatus(
      this.#runState,
      "running",
      this.#now(),
    );
    try {
      const output = await tool.invoke(
        this.#createToolContext(),
        input,
      ) as BuiltinToolOutputMap[TToolId];
      if (!isToolOutputWithId(output)) {
        throw new Error(`builtin tool did not return an outputId: ${toolId}`);
      }
      const resultRef = createToolResultRef(
        output.outputId as ToolOutputId,
        toolId,
        this.#runState.runId,
      );
      this.#runState = appendHarnessToolOutput(
        setHarnessRunStatus(this.#runState, "completed", this.#now()),
        resultRef,
        this.#now(),
      );
      return {
        output,
        resultRef,
        runState: this.getRunState(),
      };
    } catch (error) {
      this.#runState = setHarnessRunStatus(
        this.#runState,
        "failed",
        this.#now(),
      );
      throw error;
    }
  }

  #createToolContext() {
    return {
      runId: this.#runState.runId,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      sandbox: this.sandbox,
      nextOutputId: (toolId: string) => {
        this.#outputSequence += 1;
        return `${this.#runState.runId}:${toolId}:${this.#outputSequence}` as ToolOutputId;
      },
    };
  }
}

export const createHarnessEngine = (
  options: CreateHarnessEngineOptions = {},
): CfHarnessEngine => new CfHarnessEngine(options);
